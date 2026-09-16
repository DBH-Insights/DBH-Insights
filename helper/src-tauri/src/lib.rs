mod config;
mod server;
mod vcenter;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tokio::sync::RwLock;

use config::{Config, VcenterEntry};
use vcenter::VCenter;

/// Everything the settings window and the local HTTP server share.
pub struct Shared {
    pub config: RwLock<Config>,
    pub config_path: PathBuf,
    pub vcenter: VCenter,
    pub server_status: Mutex<ServerStatus>,
    /// Stops the running local server; replaced each time the server (re)starts.
    pub server_stop: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub listening: bool,
    pub port: u16,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VcenterView {
    #[serde(flatten)]
    entry: VcenterEntry,
    has_password: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    vcenters: Vec<VcenterView>,
    port: u16,
    allowed_origins: Vec<String>,
    allow_local_files: bool,
    server: ServerStatus,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneralSettings {
    port: u16,
    allowed_origins: Vec<String>,
    #[serde(default)]
    allow_local_files: bool,
}

#[tauri::command]
async fn get_settings(shared: State<'_, Arc<Shared>>) -> Result<SettingsView, String> {
    let config = shared.config.read().await.clone();
    let vcenters = config
        .vcenters
        .iter()
        .map(|entry| VcenterView {
            has_password: matches!(config::load_password(entry), Ok(Some(_))),
            entry: entry.clone(),
        })
        .collect();
    let server = shared.server_status.lock().unwrap().clone();
    Ok(SettingsView {
        vcenters,
        port: config.port,
        allowed_origins: config.allowed_origins,
        allow_local_files: config.allow_local_files,
        server,
    })
}

#[tauri::command]
async fn save_general(shared: State<'_, Arc<Shared>>, settings: GeneralSettings) -> Result<(), String> {
    if settings.port < 1024 {
        return Err("Choose a port from 1024 to 65535.".into());
    }
    // Switch ports now rather than on the next restart. If the new port can't be opened,
    // nothing is saved and the helper keeps listening where it was.
    let running = shared.server_status.lock().unwrap().clone();
    if !running.listening || running.port != settings.port {
        server::start(shared.inner().clone(), settings.port).await?;
    }

    let mut config = shared.config.write().await;
    let mut next = config.clone();
    next.port = settings.port;
    next.allowed_origins = settings.allowed_origins;
    next.allow_local_files = settings.allow_local_files;
    let next = next.normalized();
    next.save(&shared.config_path)
        .map_err(|e| format!("Could not write settings file: {e}"))?;
    *config = next;
    Ok(())
}

/// Adds (empty id) or updates a vCenter. Returns its id.
#[tauri::command]
async fn save_vcenter(
    shared: State<'_, Arc<Shared>>,
    vcenter: VcenterEntry,
    password: Option<String>,
) -> Result<String, String> {
    let mut entry = vcenter.normalized();
    if !entry.is_complete() {
        return Err("Address and username are required.".into());
    }

    let mut config = shared.config.write().await;
    let mut next = config.clone();
    let index = next.vcenters.iter().position(|v| !entry.id.is_empty() && v.id == entry.id);
    let previous = index.map(|i| next.vcenters[i].clone());
    if previous.is_none() {
        entry.id = next.new_id();
    }
    let login_changed = previous
        .as_ref()
        .is_some_and(|old| old.keyring_account() != entry.keyring_account());

    match password.filter(|p| !p.is_empty()) {
        Some(password) => config::save_password(&entry, &password)
            .map_err(|e| format!("Could not save the password to the OS keychain: {e}"))?,
        None if login_changed => {
            // Address or username changed without a new password: carry the old one over.
            if let Ok(Some(password)) = config::load_password(previous.as_ref().unwrap()) {
                config::save_password(&entry, &password)
                    .map_err(|e| format!("Could not save the password to the OS keychain: {e}"))?;
            }
        }
        None => {}
    }

    match index {
        Some(i) => next.vcenters[i] = entry.clone(),
        None => next.vcenters.push(entry.clone()),
    }
    next.save(&shared.config_path)
        .map_err(|e| format!("Could not write settings file: {e}"))?;
    if login_changed {
        config::delete_password_if_unused(&next, previous.as_ref().unwrap());
    }
    *config = next;
    drop(config);

    shared.vcenter.forget(&entry.id).await;
    Ok(entry.id)
}

#[tauri::command]
async fn delete_vcenter(shared: State<'_, Arc<Shared>>, id: String) -> Result<(), String> {
    let mut config = shared.config.write().await;
    let mut next = config.clone();
    let Some(index) = next.vcenters.iter().position(|v| v.id == id) else {
        return Ok(());
    };
    let removed = next.vcenters.remove(index);
    next.save(&shared.config_path)
        .map_err(|e| format!("Could not write settings file: {e}"))?;
    config::delete_password_if_unused(&next, &removed);
    *config = next;
    drop(config);

    shared.vcenter.forget(&id).await;
    Ok(())
}

#[tauri::command]
async fn test_vcenter(shared: State<'_, Arc<Shared>>, id: String) -> Result<String, String> {
    let entry = shared
        .config
        .read()
        .await
        .find(&id)
        .cloned()
        .ok_or("That vCenter no longer exists.")?;
    shared.vcenter.test(&entry).await.map_err(|e| e.message)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit DBH Insights Helper", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("DBH Insights Helper")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let config_path = app.path().app_config_dir()?.join("config.json");
            let config = Config::load(&config_path);
            // Persist a migrated single-vCenter file in the new layout right away.
            let _ = config.save(&config_path);
            let configured = !config.vcenters.is_empty();
            let port = config.port;

            let shared = Arc::new(Shared {
                config: RwLock::new(config),
                config_path,
                vcenter: VCenter::new(),
                server_status: Mutex::new(ServerStatus { port, ..Default::default() }),
                server_stop: Mutex::new(None),
            });
            app.manage(shared.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(e) = server::start(shared.clone(), port).await {
                    shared.server_status.lock().unwrap().error = Some(e);
                }
            });

            build_tray(app)?;

            // Set-it-and-forget-it: only pop the window when there is nothing configured yet.
            if !configured {
                show_main_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the helper running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_general,
            save_vcenter,
            delete_vcenter,
            test_vcenter
        ])
        .build(tauri::generate_context!())
        .expect("error while building DBH Insights Helper");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main_window(app),
        RunEvent::Exit => {
            // Close vCenter sessions on the way out rather than leaving them to time out.
            let shared = app.state::<Arc<Shared>>().inner().clone();
            tauri::async_runtime::block_on(shared.vcenter.logout_all());
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn shared() -> Arc<Shared> {
        Arc::new(Shared {
            config: RwLock::new(Config::default()),
            config_path: std::env::temp_dir().join("dbh-insights-helper-test-config.json"),
            vcenter: VCenter::new(),
            server_status: Mutex::new(ServerStatus::default()),
            server_stop: Mutex::new(None),
        })
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    /// A fresh client each time, so a pooled connection can't reach a stopped server.
    async fn answers(port: u16) -> bool {
        reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/status"))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn changing_the_port_moves_the_server_immediately() {
        let shared = shared();
        let (first, second) = (free_port(), free_port());

        server::start(shared.clone(), first).await.unwrap();
        assert!(answers(first).await, "listening on the first port");

        server::start(shared.clone(), second).await.unwrap();
        assert!(answers(second).await, "listening on the new port");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!answers(first).await, "old port closed");
        assert_eq!(shared.server_status.lock().unwrap().port, second);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_port_in_use_keeps_the_current_server() {
        let shared = shared();
        let current = free_port();
        server::start(shared.clone(), current).await.unwrap();

        let blocker = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let busy = blocker.local_addr().unwrap().port();
        let error = server::start(shared.clone(), busy).await.unwrap_err();
        assert!(error.contains("Could not listen"), "{error}");

        assert!(answers(current).await, "still listening on the original port");
        assert_eq!(shared.server_status.lock().unwrap().port, current);
    }
}
