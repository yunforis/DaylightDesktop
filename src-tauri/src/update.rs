//! [桌面端专有] 应用内自动更新。
//!
//! 为什么全部放在 Rust 侧：应用页由回环 HTTP（`http://127.0.0.1:<port>`）提供，
//! 而「替换自己的安装文件」是这台机器上权限最高的操作之一。把它做成纯原生能力，
//! 页面即使被注入也调不到更新命令；同时 Tauri 的更新签名校验发生在原生侧，
//! 不依赖 WebView 里的任何脚本。
//!
//! 行为：启动后静默检查一次（有更新才提示，已是最新不打扰）；托盘菜单可手动检查。
//! 用户确认后才下载安装，安装完成自动重启。绝不静默安装。
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// 防止自动检查与托盘手动检查并发跑两遍（两个更新器同时下载会互相踩安装文件）。
static RUNNING: AtomicBool = AtomicBool::new(false);

/// 启动后自动检查：延迟几秒，让本地后台与窗口先就绪。
pub fn check_in_background(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(6));
        match run(&app, true) {
            // 自动检查失败不打扰用户：离线、GitHub 暂时不可达都很常见，只留一条日志。
            Err(error) => eprintln!("[update] 自动检查未完成：{error}"),
            Ok(_) => {}
        }
    });
}

/// 托盘菜单手动检查：无论成功、失败还是已是最新，都给用户一个明确反馈。
pub fn check_now(app: AppHandle) {
    std::thread::spawn(move || {
        match run(&app, false) {
            Ok(_) => {}
            Err(error) => {
                message(&app, MessageDialogKind::Error, "检查更新失败", format!(
                    "{error}\n\n请确认网络可以访问 GitHub，稍后再试。不影响本地已有功能。"
                ));
            }
        }
    });
}

/// `run` 的正常出口里没有「已安装」：安装成功后 `app.restart()` 不会返回。
enum Outcome {
    UpToDate,
    Declined,
    /// 取不到可用的发布信息：还没发布过正式版本，或最新版本没提供当前系统的包。
    /// 这不是故障，不该按「检查更新失败」提示。
    NoReleaseInfo,
}

fn message(app: &AppHandle, kind: MessageDialogKind, title: &str, body: String) {
    app.dialog().message(body).title(title).kind(kind).blocking_show();
}

/// `silent_when_current` 为真时，已是最新就不弹窗（启动时的自动检查用这一档）。
fn run(app: &AppHandle, silent_when_current: bool) -> Result<Outcome, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("已有一次更新检查正在进行。".to_string());
    }
    let result = run_inner(app, silent_when_current);
    RUNNING.store(false, Ordering::SeqCst);
    result
}

/// 把「没有可用的发布信息」与「真的出错了」分开。
///
/// 端点还没发布过任何正式版本时，GitHub 的 `latest.json` 返回 404；更新插件把 404 折叠成
/// `ReleaseNotFound`。`TargetNotFound` 则是发布页存在、但没有当前平台/架构的条目（比如某个
/// 平台的包构建失败了）。这两种都不是网络故障，按「检查更新失败，请确认网络」提示会把人
/// 引到错误的方向，所以在原生侧翻译成人话。
fn describe_unavailable(error: tauri_plugin_updater::Error, current: &str) -> String {
    match error {
        tauri_plugin_updater::Error::ReleaseNotFound => format!(
            "还没有取到可用的更新信息（当前 {current}）。\n\n\
             常见原因是还没有发布过新版本；也可能是网络暂时访问不到 GitHub。\n\
             已安装的版本不受影响。"
        ),
        tauri_plugin_updater::Error::TargetNotFound(target) => format!(
            "最新版本还没有为你的系统提供安装包（{target}）。\n\n\
             你可以到发布页手动下载对应平台的安装包。"
        ),
        tauri_plugin_updater::Error::TargetsNotFound(targets) => format!(
            "最新版本还没有为你的系统提供安装包（{}）。\n\n\
             你可以到发布页手动下载对应平台的安装包。",
            targets.join(" / ")
        ),
        other => format!("{other}"),
    }
}

fn run_inner(app: &AppHandle, silent_when_current: bool) -> Result<Outcome, String> {
    let current = app.package_info().version.to_string();
    let updater = app.updater().map_err(|error| error.to_string())?;
    let update = match tauri::async_runtime::block_on(updater.check()) {
        Ok(update) => update,
        Err(error @ (tauri_plugin_updater::Error::ReleaseNotFound
            | tauri_plugin_updater::Error::TargetNotFound(_)
            | tauri_plugin_updater::Error::TargetsNotFound(_))) => {
            if !silent_when_current {
                message(app, MessageDialogKind::Info, "Daylight 更新", describe_unavailable(error, &current));
            }
            return Ok(Outcome::NoReleaseInfo);
        }
        Err(error) => return Err(error.to_string()),
    };

    let Some(update) = update else {
        if !silent_when_current {
            message(app, MessageDialogKind::Info, "Daylight 更新", format!("当前已是最新版本（{current}）。"));
        }
        return Ok(Outcome::UpToDate);
    };

    let version = update.version.clone();
    let tail = "现在下载并安装吗？安装完成后 Daylight 会自动重启，本地数据与配置不受影响。";
    let message_body = match update.body.as_deref() {
        // 更新说明来自发布页，属于外部数据：只截断显示，不解析、不执行。
        Some(notes) if !notes.trim().is_empty() => {
            let notes: String = notes.trim().chars().take(600).collect();
            format!("发现新版本 {version}（当前 {current}）。\n\n更新说明：\n{notes}\n\n{tail}")
        }
        _ => format!("发现新版本 {version}（当前 {current}）。\n\n{tail}"),
    };
    let confirmed = app
        .dialog()
        .message(message_body)
        .title("Daylight 更新")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("下载并安装".to_string(), "稍后".to_string()))
        .blocking_show();
    if !confirmed {
        return Ok(Outcome::Declined);
    }

    // 下载可能持续一段时间。阻塞式对话框已经关掉了，这里用窗口标题给出可见反馈，
    // 否则用户点了「下载并安装」之后会看到界面毫无反应。
    set_title(app, "Daylight — 正在下载更新…");
    let installed = tauri::async_runtime::block_on(async {
        update.download_and_install(|_chunk, _total| {}, || {}).await
    });
    if let Err(error) = installed {
        set_title(app, "Daylight");
        return Err(format!(
            "下载或安装更新失败：{error}\n\n已保留当前版本 {current}，可稍后在托盘菜单重试。"
        ));
    }
    set_title(app, "Daylight — 更新完成，正在重启…");
    // `restart()` 返回 `!`，可以强制转换成任何类型；写到这里就说明不会再往下走了。
    app.restart()
}

fn set_title(app: &AppHandle, title: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(title);
    }
}
