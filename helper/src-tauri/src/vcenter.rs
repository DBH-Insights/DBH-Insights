use std::collections::HashMap;
use std::error::Error as _;
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use reqwest::header::{CONTENT_TYPE, SET_COOKIE};
use reqwest::{Client, Method};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::config::{self, VcenterEntry};

const SOAP_ACTION: &str = "urn:vim25/8.0";
const LOGOUT_TIMEOUT: Duration = Duration::from_secs(5);

/// A failure inside the helper itself (as opposed to vCenter answering with an error status).
#[derive(Debug)]
pub struct VcError {
    pub kind: &'static str,
    pub status: StatusCode,
    pub message: String,
}

impl VcError {
    fn not_configured(message: impl Into<String>) -> Self {
        Self { kind: "not_configured", status: StatusCode::CONFLICT, message: message.into() }
    }
    fn auth(message: impl Into<String>) -> Self {
        Self { kind: "vcenter_auth_failed", status: StatusCode::BAD_GATEWAY, message: message.into() }
    }
    fn network(message: impl Into<String>) -> Self {
        Self { kind: "vcenter_unreachable", status: StatusCode::BAD_GATEWAY, message: message.into() }
    }
}

fn network_error(context: &str, err: reqwest::Error) -> VcError {
    // reqwest's top-level message is vague ("error sending request"); include the cause chain.
    let mut message = format!("{context}: {err}");
    let mut source = err.source();
    while let Some(cause) = source {
        message.push_str(&format!(" → {cause}"));
        source = cause.source();
    }
    VcError::network(message)
}

pub struct Upstream {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

impl Upstream {
    async fn read(response: reqwest::Response) -> Result<Self, VcError> {
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = response
            .bytes()
            .await
            .map_err(|e| network_error("Could not read vCenter response", e))?
            .to_vec();
        Ok(Self { status, content_type, body })
    }
}

/// Escape text interpolated into a SOAP envelope. A password containing `&` or `<`
/// would otherwise produce malformed XML that looks like a bad login.
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

fn soap_envelope(body: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:vim25="urn:vim25"><soapenv:Body>{body}</soapenv:Body></soapenv:Envelope>"#
    )
}

/// Per-vCenter login state. REST and SOAP have separate sessions.
#[derive(Default)]
struct Session {
    fingerprint: String,
    base_url: String,
    client: Option<Client>,
    /// REST `vmware-api-session-id`.
    token: Option<String>,
    /// SOAP `vmware_soap_session=…` cookie.
    soap_cookie: Option<String>,
}

impl Session {
    fn client_for(&mut self, entry: &VcenterEntry) -> Result<Client, VcError> {
        let fingerprint = entry.connection_fingerprint();
        if self.fingerprint != fingerprint || self.client.is_none() {
            let client = Client::builder()
                .danger_accept_invalid_certs(entry.accept_invalid_certs)
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(120))
                .build()
                .map_err(|e| network_error("Could not create HTTP client", e))?;
            *self = Session {
                fingerprint,
                base_url: entry.base_url(),
                client: Some(client),
                token: None,
                soap_cookie: None,
            };
        }
        Ok(self.client.clone().expect("client was just set"))
    }

    /// Ends both sessions on vCenter. vCenter keeps abandoned sessions for ~30 minutes,
    /// so dropping them without logging out piles them up.
    async fn logout(self) {
        let Some(client) = self.client else { return };
        if let Some(token) = self.token {
            let _ = client
                .delete(format!("{}/api/session", self.base_url))
                .header("vmware-api-session-id", token)
                .timeout(LOGOUT_TIMEOUT)
                .send()
                .await;
        }
        if let Some(cookie) = self.soap_cookie {
            let _ = client
                .post(format!("{}/sdk", self.base_url))
                .header(CONTENT_TYPE, "text/xml; charset=utf-8")
                .header("SOAPAction", SOAP_ACTION)
                .header("Cookie", cookie)
                .body(soap_envelope(
                    r#"<vim25:Logout><vim25:_this type="SessionManager">SessionManager</vim25:_this></vim25:Logout>"#,
                ))
                .timeout(LOGOUT_TIMEOUT)
                .send()
                .await;
        }
    }
}

/// One REST and one SOAP session per configured vCenter, re-authenticating when they expire.
pub struct VCenter {
    sessions: std::sync::Mutex<HashMap<String, Arc<Mutex<Session>>>>,
}

impl VCenter {
    pub fn new() -> Self {
        Self { sessions: std::sync::Mutex::new(HashMap::new()) }
    }

    /// Logs out and drops the sessions for one vCenter (after it is edited, deleted, or re-tested).
    pub async fn forget(&self, id: &str) {
        let slot = self.sessions.lock().unwrap().remove(id);
        if let Some(slot) = slot {
            let session = std::mem::take(&mut *slot.lock().await);
            session.logout().await;
        }
    }

    /// Logs out of every vCenter. Called when the helper quits.
    pub async fn logout_all(&self) {
        let slots: Vec<_> = self.sessions.lock().unwrap().drain().map(|(_, slot)| slot).collect();
        for slot in slots {
            let session = std::mem::take(&mut *slot.lock().await);
            session.logout().await;
        }
    }

    fn slot(&self, id: &str) -> Arc<Mutex<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .entry(id.to_string())
            .or_default()
            .clone()
    }

    /// Returns a client and REST session token, logging in if needed.
    /// `stale_token` forces a fresh login if the cached token is still that one.
    async fn rest_session(&self, entry: &VcenterEntry, stale_token: Option<&str>) -> Result<(Client, String), VcError> {
        // Each vCenter has its own lock, so a slow login to one doesn't block the others.
        let slot = self.slot(&entry.id);
        let mut session = slot.lock().await;
        let client = session.client_for(entry)?;
        if stale_token.is_some() && session.token.as_deref() == stale_token {
            session.token = None;
        }
        if let Some(token) = &session.token {
            return Ok((client, token.clone()));
        }
        let token = rest_login(&client, entry).await?;
        session.token = Some(token.clone());
        Ok((client, token))
    }

    /// Returns a client and SOAP session cookie, logging in if needed.
    async fn soap_session(&self, entry: &VcenterEntry, stale_cookie: Option<&str>) -> Result<(Client, String), VcError> {
        let slot = self.slot(&entry.id);
        let mut session = slot.lock().await;
        let client = session.client_for(entry)?;
        if stale_cookie.is_some() && session.soap_cookie.as_deref() == stale_cookie {
            session.soap_cookie = None;
        }
        if let Some(cookie) = &session.soap_cookie {
            return Ok((client, cookie.clone()));
        }
        let cookie = soap_login(&client, entry).await?;
        session.soap_cookie = Some(cookie.clone());
        Ok((client, cookie))
    }

    fn require_complete(entry: &VcenterEntry) -> Result<(), VcError> {
        if entry.is_complete() {
            return Ok(());
        }
        Err(VcError::not_configured(format!(
            "vCenter \"{}\" is missing its address or username. Fix it in the DBH Insights Helper window.",
            entry.name
        )))
    }

    pub async fn request(
        &self,
        entry: &VcenterEntry,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Upstream, VcError> {
        Self::require_complete(entry)?;
        let url = format!("{}{}", entry.base_url(), path);

        let (client, token) = self.rest_session(entry, None).await?;
        let mut response = send_rest(&client, &method, &url, &token, body).await?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            // Session expired (vCenter idles them out); log in again and retry once.
            let (client, token) = self.rest_session(entry, Some(&token)).await?;
            response = send_rest(&client, &method, &url, &token, body).await?;
        }
        Upstream::read(response).await
    }

    /// Sends one SOAP operation (already validated as read-only) inside an envelope.
    pub async fn soap(&self, entry: &VcenterEntry, operation: &str) -> Result<Upstream, VcError> {
        Self::require_complete(entry)?;
        let url = format!("{}/sdk", entry.base_url());

        let (client, cookie) = self.soap_session(entry, None).await?;
        let mut upstream = Upstream::read(send_soap(&client, &url, Some(&cookie), operation).await?).await?;
        if is_not_authenticated(&upstream) {
            let (client, cookie) = self.soap_session(entry, Some(&cookie)).await?;
            upstream = Upstream::read(send_soap(&client, &url, Some(&cookie), operation).await?).await?;
        }
        Ok(upstream)
    }

    /// Used by the settings window's "Test" buttons. Checks both REST and SOAP logins.
    pub async fn test(&self, entry: &VcenterEntry) -> Result<String, VcError> {
        self.forget(&entry.id).await;
        let upstream = self
            .request(entry, Method::GET, "/api/appliance/system/version", None)
            .await?;
        let rest = match upstream.status {
            200 => {
                let info: Value = serde_json::from_slice(&upstream.body).unwrap_or_default();
                let version = info["version"].as_str().unwrap_or("?");
                let build = info["build"].as_str().unwrap_or("?");
                format!("Connected to vCenter {version} (build {build})")
            }
            401 => return Err(VcError::auth("vCenter accepted the login but rejected the session.")),
            // Signed in fine; this account just can't read the appliance version.
            _ => "Signed in to vCenter".into(),
        };

        let soap = self
            .soap(
                entry,
                r#"<vim25:RetrieveServiceContent><vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this></vim25:RetrieveServiceContent>"#,
            )
            .await?;
        if !(200..300).contains(&soap.status) {
            return Err(VcError::network(format!(
                "{rest}, but the SOAP API returned HTTP {}.",
                soap.status
            )));
        }
        Ok(format!("{rest}. REST and SOAP OK."))
    }
}

fn is_not_authenticated(upstream: &Upstream) -> bool {
    upstream.status == 500 && String::from_utf8_lossy(&upstream.body).contains("NotAuthenticated")
}

fn saved_password(entry: &VcenterEntry) -> Result<String, VcError> {
    config::load_password(entry)
        .map_err(|e| VcError::not_configured(format!("Could not read the password from the OS keychain: {e}")))?
        .ok_or_else(|| {
            VcError::not_configured(format!(
                "No password is saved for vCenter \"{}\". Enter it in the DBH Insights Helper window.",
                entry.name
            ))
        })
}

async fn rest_login(client: &Client, entry: &VcenterEntry) -> Result<String, VcError> {
    let password = saved_password(entry)?;
    let response = client
        .post(format!("{}/api/session", entry.base_url()))
        .basic_auth(&entry.username, Some(password))
        .send()
        .await
        .map_err(|e| network_error(&format!("Could not reach {}", entry.base_url()), e))?;

    match response.status() {
        s if s.is_success() => response
            .json::<String>()
            .await
            .map_err(|e| network_error("Unexpected login response from vCenter", e)),
        reqwest::StatusCode::UNAUTHORIZED => Err(VcError::auth(format!(
            "vCenter \"{}\" rejected the username or password.",
            entry.name
        ))),
        reqwest::StatusCode::NOT_FOUND => Err(VcError::network(
            "vCenter has no /api/session endpoint. vCenter 7.0 U2 or later is required.",
        )),
        s => Err(VcError::network(format!("vCenter login failed with HTTP {s}."))),
    }
}

async fn soap_login(client: &Client, entry: &VcenterEntry) -> Result<String, VcError> {
    let password = saved_password(entry)?;
    let body = format!(
        r#"<vim25:Login><vim25:_this type="SessionManager">SessionManager</vim25:_this><vim25:userName>{}</vim25:userName><vim25:password>{}</vim25:password></vim25:Login>"#,
        xml_escape(&entry.username),
        xml_escape(&password)
    );
    let response = send_soap(client, &format!("{}/sdk", entry.base_url()), None, &body).await?;

    let cookie = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|v| v.split(';').next())
        .map(str::trim)
        .find(|v| v.starts_with("vmware_soap_session"))
        .map(str::to_owned);
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| network_error("Could not read the SOAP login response", e))?;

    if text.contains("InvalidLogin") {
        return Err(VcError::auth(format!(
            "vCenter \"{}\" rejected the username or password (SOAP).",
            entry.name
        )));
    }
    if !status.is_success() {
        return Err(VcError::network(format!("vCenter SOAP login failed with HTTP {status}.")));
    }
    cookie.ok_or_else(|| VcError::network("vCenter SOAP login returned no session cookie."))
}

async fn send_rest(
    client: &Client,
    method: &Method,
    url: &str,
    token: &str,
    body: Option<&Value>,
) -> Result<reqwest::Response, VcError> {
    let mut request = client
        .request(method.clone(), url)
        .header("vmware-api-session-id", token);
    if let Some(body) = body {
        request = request.json(body);
    }
    request
        .send()
        .await
        .map_err(|e| network_error("vCenter request failed", e))
}

async fn send_soap(
    client: &Client,
    url: &str,
    cookie: Option<&str>,
    operation: &str,
) -> Result<reqwest::Response, VcError> {
    let mut request = client
        .post(url)
        .header(CONTENT_TYPE, "text/xml; charset=utf-8")
        .header("SOAPAction", SOAP_ACTION)
        .body(soap_envelope(operation));
    if let Some(cookie) = cookie {
        request = request.header("Cookie", cookie);
    }
    request
        .send()
        .await
        .map_err(|e| network_error("vCenter SOAP request failed", e))
}

#[cfg(test)]
mod tests {
    use super::xml_escape;

    #[test]
    fn escapes_credentials_for_xml() {
        assert_eq!(xml_escape(r#"p&ss<w>rd"'"#), "p&amp;ss&lt;w&gt;rd&quot;&apos;");
    }
}
