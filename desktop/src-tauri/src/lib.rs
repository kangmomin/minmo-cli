// Tauri 진입점. invoke 이름은 desktop/src/lib/tauri.ts 의 TAURI_COMMANDS 와 1:1,
// 이벤트 이름은 TAURI_EVENTS("pty-data", "script-log") 와 일치해야 한다.
mod commands;

use commands::{fs, git, keychain, pty, script};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // single-instance 는 가장 먼저 등록해야 한다. deep-link feature 가 켜져 있으면
    // 두 번째 인스턴스로 들어온 minmo:// URL 을 deep-link 플러그인의 onOpenUrl 로 전달한다.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::default())
        .manage(script::ScriptState::default())
        .setup(|_app| {
            // 개발 실행(설치기 없음)에서는 minmo:// 스킴을 런타임에 등록한다
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                _app.deep_link().register_all()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            git::git_run,
            git::gh_run,
            git::gh_available,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_by_cwd,
            script::script_run,
            script::script_cancel,
            keychain::keychain_get,
            keychain::keychain_set,
            keychain::keychain_delete,
            fs::home_dir,
            fs::os_platform,
            fs::path_exists,
            fs::remove_dir,
            fs::copy_tree,
            fs::list_files,
            fs::copy_file_into,
            fs::remove_file_in,
            fs::open_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
