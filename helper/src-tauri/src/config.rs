use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const DEFAULT_PORT: u16 = 8765;
const KEYRING_SERVICE: &str = "dbh-insights-helper";

/// One vCenter the helper can reach. The password is not stored here; it lives in the OS keychain.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VcenterEntry {
    /// Stable id the website uses to address this vCenter.
    pub id: String,
    /// Display name shown in the helper and on the website. Defaults to the host.
    pub name: String,
    /// FQDN or IP, optionally with :port. No scheme.
    pub host: String,
    pub username: String,
    /// vCenter usually ships with a self-signed certificate.
    pub accept_invalid_certs: bool,
}

impl VcenterEntry {
    pub fn normalized(mut self) -> Self {
        let host = self.host.trim();
        let host = host
            .strip_prefix("https://")
            .or_else(|| host.strip_prefix("http://"))
            .unwrap_or(host);
        self.host = host.trim_end_matches('/').to_string();
        self.username = self.username.trim().to_string();
        self.name = self.name.trim().to_string();
        if self.name.is_empty() {
            self.name = self.host.clone();
        }
        self
    }

    pub fn is_complete(&self) -> bool {
        !self.host.is_empty() && !self.username.is_empty()
    }

    pub fn base_url(&self) -> String {
        format!("https://{}", self.host)
    }

    /// Changes to any of these invalidate the cached HTTP client and vCenter session.
    pub fn connection_fingerprint(&self) -> String {
        format!("{}|{}|{}", self.host, self.username, self.accept_invalid_certs)
    }

    pub fn keyring_account(&self) -> String {
        format!("{}@{}", self.username, self.host)
    }
}

/// Non-secret settings, stored as JSON in the OS app-config directory.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub vcenters: Vec<VcenterEntry>,
    /// Port the helper listens on (127.0.0.1 only). Changing it in the settings window switches immediately.
    pub port: u16,
    /// Website origins allowed to use the pass-through, e.g. "https://insights.example.com".
    pub allowed_origins: Vec<String>,
    /// Allow the website when it's opened from a local file. Browsers send such pages
    /// with the origin "null", which any website can also produce from a sandboxed
    /// frame, so this is an explicit opt-in rather than an entry in `allowed_origins`.
    pub allow_local_files: bool,

    // Single-vCenter settings from version 0.1 files; migrated into `vcenters` on load.
    #[serde(skip_serializing)]
    vcenter_host: Option<String>,
    #[serde(skip_serializing)]
    username: Option<String>,
    #[serde(skip_serializing)]
    accept_invalid_certs: Option<bool>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            vcenters: Vec::new(),
            port: DEFAULT_PORT,
            allowed_origins: vec![
                // The published DBH Insights website.
                "https://dbh-insights.github.io".into(),
                // Local development copies of the website.
                "http://localhost:5500".into(),
                "http://127.0.0.1:5500".into(),
            ],
            allow_local_files: false,
            vcenter_host: None,
            username: None,
            accept_invalid_certs: None,
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Self {
        fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Config>(&text).ok())
            .map(Config::normalized)
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(self).expect("config serializes");
        fs::write(path, text)
    }

    pub fn normalized(mut self) -> Self {
        // Migrate the old single-vCenter layout.
        let legacy_host = self.vcenter_host.take().unwrap_or_default();
        let legacy_user = self.username.take().unwrap_or_default();
        let legacy_insecure = self.accept_invalid_certs.take().unwrap_or(true);
        if self.vcenters.is_empty() && !legacy_host.trim().is_empty() {
            let id = self.new_id();
            self.vcenters.push(VcenterEntry {
                id,
                name: String::new(),
                host: legacy_host,
                username: legacy_user,
                accept_invalid_certs: legacy_insecure,
            });
        }

        let entries = std::mem::take(&mut self.vcenters);
        for entry in entries {
            let mut entry = entry.normalized();
            if entry.id.is_empty() || self.find(&entry.id).is_some() {
                entry.id = self.new_id();
            }
            self.vcenters.push(entry);
        }

        if self.port == 0 {
            self.port = DEFAULT_PORT;
        }

        let mut origins: Vec<String> = Vec::new();
        for origin in &self.allowed_origins {
            let origin = origin.trim().trim_end_matches('/').to_ascii_lowercase();
            // "null" is the origin of pages opened from local files, but also of sandboxed
            // frames that any website can create. It's controlled by `allow_local_files`
            // instead; a "null" typed into the list turns that setting on.
            if origin == "null" {
                self.allow_local_files = true;
                continue;
            }
            if !origin.is_empty() && !origins.contains(&origin) {
                origins.push(origin);
            }
        }
        self.allowed_origins = origins;
        self
    }

    pub fn find(&self, id: &str) -> Option<&VcenterEntry> {
        self.vcenters.iter().find(|v| v.id == id)
    }

    pub fn new_id(&self) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let mut n = nanos;
        loop {
            let id = format!("vc-{:x}", n % 0xffff_ffff_ffff);
            if self.find(&id).is_none() {
                return id;
            }
            n += 1;
        }
    }

    pub fn origin_allowed(&self, origin: &str) -> bool {
        let origin = origin.trim_end_matches('/').to_ascii_lowercase();
        if origin == "null" {
            return self.allow_local_files;
        }
        self.allowed_origins.iter().any(|allowed| *allowed == origin)
    }
}

pub fn load_password(entry: &VcenterEntry) -> keyring::Result<Option<String>> {
    match keyring::Entry::new(KEYRING_SERVICE, &entry.keyring_account())?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn save_password(entry: &VcenterEntry, password: &str) -> keyring::Result<()> {
    keyring::Entry::new(KEYRING_SERVICE, &entry.keyring_account())?.set_password(password)
}

/// Removes the keychain password for `entry` unless another configured vCenter uses the same login.
pub fn delete_password_if_unused(config: &Config, entry: &VcenterEntry) {
    let account = entry.keyring_account();
    if config.vcenters.iter().any(|v| v.keyring_account() == account) {
        return;
    }
    if let Ok(keychain_entry) = keyring::Entry::new(KEYRING_SERVICE, &account) {
        let _ = keychain_entry.delete_credential();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_single_vcenter_file() {
        let old = r#"{"vcenterHost":"https://vc.lab/","username":"admin","acceptInvalidCerts":true,
                      "port":8765,"allowedOrigins":["http://localhost:5500"],"allowWriteMethods":false}"#;
        let config = serde_json::from_str::<Config>(old).unwrap().normalized();
        assert_eq!(config.vcenters.len(), 1);
        let vc = &config.vcenters[0];
        assert_eq!(vc.host, "vc.lab");
        assert_eq!(vc.name, "vc.lab");
        assert_eq!(vc.keyring_account(), "admin@vc.lab");
        assert!(!vc.id.is_empty());

        let saved = serde_json::to_string(&config).unwrap();
        assert!(!saved.contains("vcenterHost"));
    }

    #[test]
    fn new_settings_allow_the_published_website() {
        let config = Config::default().normalized();
        assert!(config.origin_allowed("https://dbh-insights.github.io"));
        assert!(config.origin_allowed("https://dbh-insights.github.io/"));
        assert!(config.origin_allowed("http://localhost:5500"));
        assert!(!config.origin_allowed("https://evil.github.io"));
    }

    #[test]
    fn local_files_are_refused_unless_opted_in() {
        let config = Config::default().normalized();
        assert!(!config.allow_local_files);
        assert!(!config.origin_allowed("null"));

        // A "null" in the list alone never allows it without the setting.
        let mut raw = Config::default();
        raw.allowed_origins.push("null".into());
        assert!(!raw.origin_allowed("null"));

        let mut opted_in = Config::default();
        opted_in.allow_local_files = true;
        assert!(opted_in.origin_allowed("null"));
        assert!(!opted_in.origin_allowed("https://evil.example.com"));
    }

    #[test]
    fn null_in_the_list_becomes_the_local_files_setting() {
        let text = r#"{"allowedOrigins":["https://dbh-insights.github.io","null"," NULL "]}"#;
        let config = serde_json::from_str::<Config>(text).unwrap().normalized();
        assert_eq!(config.allowed_origins, vec!["https://dbh-insights.github.io".to_string()]);
        assert!(config.allow_local_files);
        assert!(config.origin_allowed("null"));
    }

    #[test]
    fn fixes_missing_and_duplicate_ids() {
        let text = r#"{"vcenters":[{"id":"a","host":"one"},{"id":"a","host":"two"},{"host":"three"}]}"#;
        let config = serde_json::from_str::<Config>(text).unwrap().normalized();
        let ids: Vec<_> = config.vcenters.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids[0], "a");
        assert!(ids[1] != "a" && !ids[1].is_empty());
        assert!(!ids[2].is_empty() && ids[2] != ids[1]);
    }
}
