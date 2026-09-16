//! The local HTTP server the website talks to. Binds to 127.0.0.1 only.
//!
//! Endpoints:
//!   GET  /status  -> is the helper running, is this website allowed, which vCenters are configured
//!   POST /proxy   -> {"vcenter":"vc-…","method":"GET","path":"/api/vcenter/vm"}
//!                    passed through to that vCenter with the helper's session; vCenter's
//!                    status code and body come back unchanged. GET is the only method
//!                    accepted, and it is what `method` defaults to.
//!   POST /soap    -> {"vcenter":"vc-…","body":"<vim25:RetrieveServiceContent>…"}
//!                    one read-only vim25 operation, wrapped in an envelope here.
//!
//! Helper-side failures carry an `X-Helper-Error: <kind>` header and a body of
//! {"error":{"kind":"...","message":"..."}} so the website can tell them apart from vCenter errors.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use crate::config::{Config, VcenterEntry};
use crate::Shared;

const HELPER_ERROR_HEADER: &str = "x-helper-error";

#[derive(Clone)]
struct Caller {
    origin: Option<String>,
    allowed: bool,
}

/// Starts listening on `port` and stops any server already running.
///
/// The new port is opened before the old server is stopped, so a port that can't be
/// opened (already in use, not permitted) leaves the helper running where it was.
pub async fn start(shared: Arc<Shared>, port: u16) -> Result<(), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Could not listen on {addr}: {e}"))?;

    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    if let Some(previous) = shared.server_stop.lock().unwrap().replace(stop) {
        // Stops accepting on the old port; open connections finish and close.
        let _ = previous.send(());
    }
    {
        let mut status = shared.server_status.lock().unwrap();
        status.listening = true;
        status.port = port;
        status.error = None;
    }

    let app = Router::new()
        .route("/status", get(status))
        .route("/proxy", post(proxy))
        .route("/soap", post(soap))
        .layer(middleware::from_fn_with_state(shared.clone(), guard))
        .with_state(shared.clone());

    tauri::async_runtime::spawn(async move {
        let result = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await;
        if let Err(e) = result {
            let mut status = shared.server_status.lock().unwrap();
            // Only report it if this server is still the current one.
            if status.port == port {
                status.listening = false;
                status.error = Some(format!("Server stopped: {e}"));
            }
        }
    });
    Ok(())
}

fn helper_error(status: StatusCode, kind: &'static str, message: impl Into<String>) -> Response {
    let body = json!({ "error": { "kind": kind, "message": message.into() } });
    let mut response = (status, Json(body)).into_response();
    response
        .headers_mut()
        .insert(HELPER_ERROR_HEADER, HeaderValue::from_static(kind));
    response
}

/// Host check (DNS-rebinding defence), CORS + Private Network Access headers, origin allowlist.
async fn guard(State(shared): State<Arc<Shared>>, mut request: Request, next: Next) -> Response {
    let host_is_loopback = request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(|host| {
            let name = host.rsplit_once(':').map_or(host, |(name, _)| name);
            name == "127.0.0.1" || name.eq_ignore_ascii_case("localhost")
        })
        .unwrap_or(false);
    if !host_is_loopback {
        return helper_error(
            StatusCode::FORBIDDEN,
            "forbidden_host",
            "Requests must be addressed to 127.0.0.1 or localhost.",
        );
    }

    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|o| o.to_str().ok())
        .map(str::to_owned);

    let mut response = if request.method() == Method::OPTIONS {
        // Preflight. Answering it grants nothing by itself: the real request is checked below.
        StatusCode::NO_CONTENT.into_response()
    } else {
        // No Origin header means a non-browser client on this machine (curl, scripts).
        let allowed = match &origin {
            Some(origin) => shared.config.read().await.origin_allowed(origin),
            None => true,
        };
        request.extensions_mut().insert(Caller { origin: origin.clone(), allowed });
        next.run(request).await
    };

    let headers = response.headers_mut();
    if let Some(origin) = origin.as_deref().and_then(|o| HeaderValue::from_str(o).ok()) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
        headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("content-type"));
        headers.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static(HELPER_ERROR_HEADER));
        headers.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
        // Chrome Private Network Access: public website -> localhost.
        headers.insert("access-control-allow-private-network", HeaderValue::from_static("true"));
    }
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn status(State(shared): State<Arc<Shared>>, Extension(caller): Extension<Caller>) -> Json<Value> {
    let base = json!({
        "helper": "dbh-insights-helper",
        "version": env!("CARGO_PKG_VERSION"),
        "originAllowed": caller.allowed,
    });
    if !caller.allowed {
        // Enough for the website to explain what to do, nothing about the vCenter.
        return Json(json!({ "helper": base["helper"], "version": base["version"],
            "originAllowed": false, "origin": caller.origin }));
    }
    let config = shared.config.read().await;
    let vcenters: Vec<Value> = config
        .vcenters
        .iter()
        .map(|vc| json!({ "id": vc.id, "name": vc.name, "host": vc.host, "username": vc.username }))
        .collect();
    Json(json!({
        "helper": base["helper"],
        "version": base["version"],
        "originAllowed": true,
        "configured": !vcenters.is_empty(),
        "vcenters": vcenters,
        "capabilities": ["rest", "soap", "perf"],
    }))
}

/// Picks the vCenter a request is for. `vcenter` may be omitted when exactly one is configured.
fn resolve_vcenter(config: &Config, id: Option<&str>) -> Result<VcenterEntry, Response> {
    match (id, config.vcenters.as_slice()) {
        (_, []) => Err(helper_error(
            StatusCode::CONFLICT,
            "not_configured",
            "The helper has no vCenters configured. Open the DBH Insights Helper window and add one.",
        )),
        (Some(id), list) => list.iter().find(|vc| vc.id == id).cloned().ok_or_else(|| {
            helper_error(
                StatusCode::NOT_FOUND,
                "unknown_vcenter",
                format!("The helper has no vCenter with id \"{id}\"."),
            )
        }),
        (None, [only]) => Ok(only.clone()),
        (None, _) => Err(helper_error(
            StatusCode::BAD_REQUEST,
            "vcenter_required",
            "Several vCenters are configured. Add \"vcenter\": \"<id>\" to the request.",
        )),
    }
}

#[derive(Deserialize)]
struct ProxyRequest {
    /// Id of the target vCenter (from /status). Optional when only one is configured.
    #[serde(default)]
    vcenter: Option<String>,
    #[serde(default = "default_method")]
    method: String,
    path: String,
}

fn default_method() -> String {
    "GET".into()
}

/// The helper only pulls data from vCenter, so GET is the only REST method passed through.
fn is_read_method(method: &str) -> bool {
    method.eq_ignore_ascii_case("GET")
}

/// The pass-through only reaches vCenter's REST APIs, never the session endpoints
/// (so a web page can't read or kill the helper's token) and never another host.
fn validate_path(path: &str) -> Result<(), &'static str> {
    let lower = path.to_ascii_lowercase();
    if !(lower.starts_with("/api/") || lower.starts_with("/rest/")) {
        return Err("Path must start with /api/ or /rest/.");
    }
    if lower.starts_with("/api/session") || lower.starts_with("/rest/com/vmware/cis/session") {
        return Err("Session endpoints are managed by the helper and cannot be called directly.");
    }
    if path.contains("..") || path.contains("//") || path.contains('\\') || path.contains('@') || path.contains('#') {
        return Err("Path contains characters that are not allowed.");
    }
    if !path.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("Path must be URL-encoded ASCII with no spaces.");
    }
    Ok(())
}

fn origin_not_allowed(caller: &Caller) -> Response {
    helper_error(
        StatusCode::FORBIDDEN,
        "origin_not_allowed",
        format!(
            "This website ({}) is not in the helper's list of allowed websites.",
            caller.origin.as_deref().unwrap_or("unknown")
        ),
    )
}

/// vCenter's status code, content type and body, unchanged.
fn upstream_response(upstream: crate::vcenter::Upstream) -> Response {
    let status = StatusCode::from_u16(upstream.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response = (status, upstream.body).into_response();
    if let Some(content_type) = upstream.content_type.and_then(|c| HeaderValue::from_str(&c).ok()) {
        response.headers_mut().insert(header::CONTENT_TYPE, content_type);
    }
    response
}

async fn proxy(
    State(shared): State<Arc<Shared>>,
    Extension(caller): Extension<Caller>,
    payload: Result<Json<ProxyRequest>, JsonRejection>,
) -> Response {
    if !caller.allowed {
        return origin_not_allowed(&caller);
    }
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(e) => return helper_error(StatusCode::BAD_REQUEST, "bad_request", e.body_text()),
    };

    if !is_read_method(&request.method) {
        return helper_error(
            StatusCode::FORBIDDEN,
            "read_only",
            "The helper only reads from vCenter. Only GET requests are passed through.",
        );
    }
    if let Err(message) = validate_path(&request.path) {
        return helper_error(StatusCode::BAD_REQUEST, "bad_path", message);
    }

    let config = shared.config.read().await.clone();
    let entry = match resolve_vcenter(&config, request.vcenter.as_deref()) {
        Ok(entry) => entry,
        Err(response) => return response,
    };

    match shared
        .vcenter
        .request(&entry, Method::GET, &request.path, None)
        .await
    {
        Ok(upstream) => upstream_response(upstream),
        Err(e) => helper_error(e.status, e.kind, e.message),
    }
}

#[derive(Deserialize)]
struct SoapRequest {
    /// Id of the target vCenter (from /status). Optional when only one is configured.
    #[serde(default)]
    vcenter: Option<String>,
    /// One vim25 operation element, e.g. `<vim25:RetrievePropertiesEx>…</vim25:RetrievePropertiesEx>`.
    /// The helper supplies the envelope and the session.
    body: String,
}

/// SOAP operations the pass-through allows. All are read-only: property retrieval plus the
/// session-scoped container views it uses. Login and Logout stay with the helper.
const SOAP_READ_OPERATIONS: &[&str] = &[
    "RetrieveServiceContent",
    "RetrievePropertiesEx",
    "ContinueRetrievePropertiesEx",
    "CancelRetrievePropertiesEx",
    "CreateContainerView",
    "DestroyView",
    // PerformanceManager: counter metadata and samples. Read-only like the rest.
    "QueryPerf",
    "QueryPerfProviderSummary",
    "QueryAvailablePerfMetric",
];

const SOAP_BODY_LIMIT: usize = 1_000_000;

/// Parses the body as XML and requires exactly one top-level element naming an allowed
/// operation, so nothing else can be smuggled into the envelope.
fn validate_soap_body(body: &str) -> Result<&'static str, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    if body.len() > SOAP_BODY_LIMIT {
        return Err("SOAP body is too large.".into());
    }

    let mut reader = Reader::from_str(body);
    let mut depth = 0usize;
    let mut operation: Option<&'static str> = None;

    let top_level = |name: &[u8], operation: &mut Option<&'static str>| -> Result<(), String> {
        if operation.is_some() {
            return Err("SOAP body must contain exactly one operation.".into());
        }
        let name = std::str::from_utf8(name).unwrap_or("");
        match SOAP_READ_OPERATIONS.iter().find(|op| **op == name) {
            Some(op) => {
                *operation = Some(op);
                Ok(())
            }
            None => Err(format!(
                "SOAP operation \"{name}\" is not allowed. The helper only passes read-only property queries."
            )),
        }
    };

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                if depth == 0 {
                    top_level(e.local_name().as_ref(), &mut operation)?;
                }
                depth += 1;
            }
            Ok(Event::Empty(e)) => {
                if depth == 0 {
                    top_level(e.local_name().as_ref(), &mut operation)?;
                }
            }
            Ok(Event::End(_)) => {
                if depth == 0 {
                    return Err("SOAP body has an unmatched closing tag.".into());
                }
                depth -= 1;
            }
            Ok(Event::Text(text)) if depth == 0 => {
                if !text.iter().all(u8::is_ascii_whitespace) {
                    return Err("Text outside the operation element is not allowed.".into());
                }
            }
            Ok(Event::CData(_)) if depth == 0 => {
                return Err("Text outside the operation element is not allowed.".into());
            }
            Ok(Event::Decl(_)) | Ok(Event::DocType(_)) | Ok(Event::PI(_)) => {
                return Err("XML declarations, DOCTYPEs and processing instructions are not allowed.".into());
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => return Err(format!("SOAP body is not well-formed XML: {e}")),
        }
    }
    if depth != 0 {
        return Err("SOAP body is not well-formed XML: unclosed element.".into());
    }
    operation.ok_or_else(|| "SOAP body must contain one operation element.".into())
}

async fn soap(
    State(shared): State<Arc<Shared>>,
    Extension(caller): Extension<Caller>,
    payload: Result<Json<SoapRequest>, JsonRejection>,
) -> Response {
    if !caller.allowed {
        return origin_not_allowed(&caller);
    }
    let Json(request) = match payload {
        Ok(payload) => payload,
        Err(e) => return helper_error(StatusCode::BAD_REQUEST, "bad_request", e.body_text()),
    };
    if let Err(message) = validate_soap_body(&request.body) {
        return helper_error(StatusCode::BAD_REQUEST, "soap_not_allowed", message);
    }

    let config = shared.config.read().await.clone();
    let entry = match resolve_vcenter(&config, request.vcenter.as_deref()) {
        Ok(entry) => entry,
        Err(response) => return response,
    };

    match shared.vcenter.soap(&entry, &request.body).await {
        Ok(upstream) => upstream_response(upstream),
        Err(e) => helper_error(e.status, e.kind, e.message),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_read_method, validate_path, validate_soap_body};

    #[test]
    fn only_get_is_passed_through() {
        assert!(is_read_method("GET"));
        assert!(is_read_method("get"));
        for method in ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", ""] {
            assert!(!is_read_method(method), "{method} should be refused");
        }
    }

    const RETRIEVE: &str = r#"<vim25:RetrievePropertiesEx><vim25:_this type="PropertyCollector">propertyCollector</vim25:_this><vim25:specSet><vim25:propSet><vim25:type>HostSystem</vim25:type><vim25:pathSet>name</vim25:pathSet></vim25:propSet><vim25:objectSet><vim25:obj type="ContainerView">session[1]view</vim25:obj><vim25:skip>true</vim25:skip><vim25:selectSet xsi:type="vim25:TraversalSpec"><vim25:name>view</vim25:name><vim25:type>ContainerView</vim25:type><vim25:path>view</vim25:path><vim25:skip>false</vim25:skip></vim25:selectSet></vim25:objectSet></vim25:specSet><vim25:options/></vim25:RetrievePropertiesEx>"#;

    #[test]
    fn allows_read_only_soap_operations() {
        assert_eq!(validate_soap_body(RETRIEVE), Ok("RetrievePropertiesEx"));
        assert_eq!(
            validate_soap_body("\n  <vim25:DestroyView><vim25:_this type=\"ContainerView\">v</vim25:_this></vim25:DestroyView>\n"),
            Ok("DestroyView")
        );
        assert_eq!(
            validate_soap_body(r#"<RetrieveServiceContent xmlns="urn:vim25"><_this type="ServiceInstance">ServiceInstance</_this></RetrieveServiceContent>"#),
            Ok("RetrieveServiceContent")
        );
        assert_eq!(
            validate_soap_body(r#"<vim25:QueryPerf><vim25:_this type="PerformanceManager">PerfMgr</vim25:_this><vim25:querySpec><vim25:entity type="HostSystem">host-9</vim25:entity></vim25:querySpec></vim25:QueryPerf>"#),
            Ok("QueryPerf")
        );
    }

    #[test]
    fn rejects_writes_and_session_operations() {
        for op in ["Login", "Logout", "PowerOffVM_Task", "Destroy_Task", "CreateSnapshot_Task", "TerminateSession", "UpdatePerfInterval", "ResetCounterLevelMapping"] {
            let body = format!("<vim25:{op}><vim25:_this type=\"X\">x</vim25:_this></vim25:{op}>");
            assert!(validate_soap_body(&body).is_err(), "{op} should be rejected");
        }
    }

    #[test]
    fn rejects_smuggled_or_malformed_bodies() {
        // A second operation after an allowed one.
        assert!(validate_soap_body(&format!("{RETRIEVE}<vim25:PowerOffVM_Task/>")).is_err());
        // Breaking out of the envelope's Body.
        assert!(validate_soap_body(&format!("{RETRIEVE}</soapenv:Body>")).is_err());
        assert!(validate_soap_body("<vim25:RetrievePropertiesEx>").is_err());
        assert!(validate_soap_body("<!DOCTYPE x [<!ENTITY e \"y\">]><vim25:RetrieveServiceContent/>").is_err());
        assert!(validate_soap_body("junk<vim25:RetrieveServiceContent/>").is_err());
        assert!(validate_soap_body("").is_err());
    }

    #[test]
    fn allows_rest_paths() {
        assert!(validate_path("/api/vcenter/vm").is_ok());
        assert!(validate_path("/api/vcenter/vm?power_states=POWERED_ON").is_ok());
        assert!(validate_path("/rest/vcenter/vm").is_ok());
    }

    #[test]
    fn rejects_escapes_and_sessions() {
        assert!(validate_path("/ui/").is_err());
        assert!(validate_path("/api/session").is_err());
        assert!(validate_path("/API/Session").is_err());
        assert!(validate_path("/api/../ui").is_err());
        assert!(validate_path("/api//evil.com").is_err());
        assert!(validate_path("/api/vcenter/vm@evil.com").is_err());
        assert!(validate_path("/api/vcenter/vm name").is_err());
    }
}
