// Tauri 진입점. invoke 이름은 desktop/src/lib/tauri.ts 의 TAURI_COMMANDS 와 1:1,
// 이벤트 이름은 TAURI_EVENTS("pty-data", "script-log", "server-status", "close-requested", "update-progress") 와 일치해야 한다.
mod commands;
mod profile;
mod server;
mod shell;
mod update;

use commands::{fs, git, keychain, pty, script};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // single-instance 는 가장 먼저 등록해야 한다. deep-link feature 가 켜져 있으면
    // 두 번째 인스턴스로 들어온 minmo:// URL 을 deep-link 플러그인의 onOpenUrl 로 전달한다.
    // 트레이로 숨긴 창도 다시 띄운다.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            shell::show_main(app);
        }));
    }

    let app = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(pty::PtyState::default())
        .manage(script::ScriptState::default())
        .manage(update::UpdateState::default())
        .setup(|app| {
            // 개발 실행(설치기 없음)에서는 minmo:// 스킴을 런타임에 등록한다. 격리 프로필(E2E)은 설치된 앱의
            // 등록을 가로채지 않도록 건너뛴다 — 딥링크는 두 번째 인스턴스 인자로 전달해 시험한다
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            if !profile::isolated() {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }
            // 키체인 서비스 이름이 identifier 를 따르므로 키체인을 쓰기 전에
            profile::init(&app.config().identifier);
            let handle = app.handle().clone();
            app.manage(server::ServerManager::load(&handle));
            shell::setup_tray(&handle)?;
            // 서버 준비를 기다리는 동안 창이 멈추지 않게 백그라운드에서 띄운다(웹뷰는 server-status 로 기다린다)
            std::thread::spawn(move || handle.state::<server::ServerManager>().start(&handle));
            Ok(())
        })
        .on_window_event(shell::on_window_event)
        // 웹뷰가 새로 고쳐지면 React 정리(pty_kill)가 돌지 않으므로, 남은 터미널 프로세스를 여기서 끝낸다
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                pty::kill_all(&webview.state::<pty::PtyState>());
            }
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
            server::server_status,
            server::server_settings_get,
            server::server_settings_save,
            server::server_restart,
            server::server_open_log_dir,
            shell::app_close,
            update::app_update_check,
            update::app_update_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // 어떤 경로로 끝나든(트레이 종료·OS 종료 등) 서버를 정상 종료한다
        if let tauri::RunEvent::Exit = event {
            if let Some(mgr) = app.try_state::<server::ServerManager>() {
                mgr.shutdown(app);
            }
        }
    });
}
