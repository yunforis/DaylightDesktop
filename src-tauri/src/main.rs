#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod update;

use std::{fs, io::{BufRead, BufReader, Write}, process::{Child, Command, Stdio}, sync::Mutex, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, menu::{Menu, MenuItem, PredefinedMenuItem}, tray::TrayIconBuilder};
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
struct Backend(Mutex<Option<Child>>);

fn show(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.unminimize(); let _ = w.set_focus(); }
}
fn startup_error(app: &tauri::AppHandle, message: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.navigate("tauri://localhost".parse().unwrap());
        // On startup the loading page is already visible. Delayed evaluation also handles a failed backend after navigation.
        let w = w.clone(); let message = message.to_owned();
        std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(700)); let _ = w.eval(&format!("window.showStartupError?.({})", serde_json::to_string(&message).unwrap())); });
    }
}
fn start_backend(app: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data = app.path().app_data_dir()?;
    fs::create_dir_all(&data)?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&data, fs::Permissions::from_mode(0o700))?; }
    let entry = keyring::Entry::new(app.config().identifier.as_str(), "settings-encryption-key")?;
    let key = match entry.get_password() {
        Ok(key) => key,
        Err(keyring::Error::NoEntry) => {
            let key = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
            entry.set_password(&key)?; key
        },
        Err(error) => return Err(format!("无法解锁系统凭据库：{error}。请解锁钥匙串/Secret Service 后重新启动。没有降级为明文保存。 ").into()),
    };
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let root = if cfg!(debug_assertions) { std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf() } else { app.path().resource_dir()?.join("runtime") };
    let node = if cfg!(debug_assertions) { std::env::var_os("DAYLIGHT_NODE").map(std::path::PathBuf::from).unwrap_or_else(|| "node".into()) } else { root.join(if cfg!(windows) { "node.exe" } else { "node" }) };
    let log = fs::OpenOptions::new().create(true).append(true).open(data.join("backend.log"))?;
    let mut command = Command::new(node);
    command.arg(root.join("server/desktop-entry.js")).current_dir(&root)
        .env("DAYLIGHT_DATA_DIR", &data).env("DAYLIGHT_DESKTOP", "1")
        .env("DAYLIGHT_DESKTOP_TOKEN", &token).env("DAYLIGHT_MASTER_KEY", key)
        .env("PORT", if cfg!(debug_assertions) { "14321" } else { "14322" })
        .env_remove("NODE_OPTIONS").env_remove("NODE_PATH")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(log);
    if !cfg!(debug_assertions) { command.arg("--production"); }
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().ok_or("无法读取后台启动状态")?;
    *app.state::<Backend>().0.lock().unwrap() = Some(child);
    let reader_app = app.clone();
    std::thread::spawn(move || {
        let mut ready = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(value) = line.strip_prefix("DAYLIGHT_READY ") {
                if let Ok(port) = value.parse::<u16>() {
                    ready = true;
                    if let Some(window) = reader_app.get_webview_window("main") {
                        let url = format!("http://127.0.0.1:{port}/desktop/start?token={token}");
                        let _ = window.navigate(url.parse().unwrap());
                    }
                }
            }
        }
        if ready { startup_error(&reader_app, "本地后台已停止。请退出并重新打开 Daylight。诊断信息位于应用数据目录的 backend.log。"); }
        else { startup_error(&reader_app, "本地后台启动失败。请查看应用数据目录的 backend.log，修复后重新打开 Daylight。"); }
    });
    Ok(())
}
fn stop_backend(app: &tauri::AppHandle) {
    if let Some(mut child) = app.state::<Backend>().0.lock().unwrap().take() {
        if let Some(mut input) = child.stdin.take() { let _ = input.write_all(b"shutdown\n"); }
        for _ in 0..30 { if child.try_wait().ok().flatten().is_some() { return; } std::thread::sleep(Duration::from_millis(100)); }
        let _ = child.kill(); let _ = child.wait();
    }
}
fn main() {
    let app = tauri::Builder::default()
        .manage(Backend::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let external = handle.clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(if cfg!(debug_assertions) { "Daylight · 开发版" } else { "Daylight" })
                .inner_size(1380.0, 900.0).min_inner_size(960.0, 640.0)
                .on_navigation(move |url| {
                    if url.host_str() == Some("127.0.0.1") || url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") { return true; }
                    if matches!(url.scheme(), "http" | "https" | "mailto") { let _ = external.opener().open_url(url.as_str(), None::<&str>); }
                    false
                })
                .build()?;
            let show_item = MenuItem::with_id(app, "show", "打开 Daylight", true, None::<&str>)?;
            let update_item = MenuItem::with_id(app, "update", "检查更新…", true, None::<&str>)?;
            let data_item = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 Daylight", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show_item, &update_item, &data_item, &separator, &quit_item])?;
            TrayIconBuilder::new().icon(app.default_window_icon().unwrap().clone()).tooltip("Daylight · 邮件与日程")
                .menu(&menu).on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show(app),
                    "update" => update::check_now(app.clone()),
                    "data" => { if let Ok(path) = app.path().app_data_dir() { let _ = app.opener().open_path(path.to_string_lossy(), None::<&str>); } },
                    "quit" => app.exit(0), _ => {}
                }).build(app)?;
            let app_for_close = handle.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close(); if let Some(w) = app_for_close.get_webview_window("main") { let _ = w.hide(); }
                }
            });
            std::thread::spawn(move || { if let Err(error) = start_backend(handle.clone()) { startup_error(&handle, &error.to_string()); } });
            // 更新检查在本地后台之外单独跑：后台起不来也要能更新；检查失败不影响启动。
            update::check_in_background(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!()).expect("无法初始化 Daylight 桌面窗口");
    app.run(|app, event| match event {
        tauri::RunEvent::Exit => stop_backend(app),
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show(app),
        _ => {}
    });
}
