// Tauri 진입점. invoke 이름은 desktop/src/lib/tauri.ts 의 TAURI_COMMANDS 와 1:1,
// 이벤트 이름은 TAURI_EVENTS("pty-data", "script-log", "server-status", "close-requested", "update-progress") 와 일치해야 한다.
mod commands;
mod profile;
mod remote;
mod server;
mod shell;
mod update;

use commands::{agents, fs, git, keychain, pty, script, ssh};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // single-instance 는 가장 먼저 등록해야 한다. 두 번째로 실행하면 이미 떠 있는 창(트레이로 숨긴 창 포함)을 띄운다.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            shell::show_main(app);
        }));
    }

    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(pty::PtyState::default())
        .manage(script::ScriptState::default())
        .manage(ssh::SshState::default())
        .manage(update::UpdateState::default())
        .setup(|app| {
            // 키체인 서비스 이름이 identifier 를 따르므로 키체인을 쓰기 전에
            profile::init(&app.config().identifier);
            let handle = app.handle().clone();
            // 앱에 등록한 ssh 호스트 목록(설정 폴더)
            if let Ok(dirs) = profile::dirs(&handle) {
                ssh::init(&dirs.config);
            }
            app.manage(server::ServerManager::load(&handle));
            // 원격 접속(꺼져 있으면 아무 포트도 열지 않는다)
            remote::init(&handle);
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
                // 붙은 기기의 호출 중 이 화면에 맡겨 둔 것은 답이 오지 않는다 — 기다리게 두지 않는다
                if let Some(remote) = webview.try_state::<remote::RemoteManager>() {
                    remote.fail_pending();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            git::git_run,
            git::gh_run,
            git::gh_available,
            pty::pty_spawn,
            pty::pty_find,
            pty::pty_list,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_by_cwd,
            pty::pty_processes,
            agents::claude_subagents,
            script::script_run,
            script::script_cancel,
            ssh::ssh_hosts,
            ssh::ssh_probe,
            ssh::ssh_host_save,
            ssh::ssh_host_remove,
            ssh::ssh_exec,
            ssh::ssh_script_run,
            ssh::ssh_script_cancel,
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
            fs::fs_list_dir,
            fs::fs_read_text,
            fs::fs_write_text,
            fs::fs_create_dir,
            fs::fs_rename,
            fs::fs_remove,
            server::server_status,
            server::server_settings_get,
            server::server_settings_save,
            server::server_restart,
            server::server_open_log_dir,
            shell::app_close,
            update::app_update_check,
            update::app_update_install,
            remote::remote_status,
            remote::remote_configure,
            remote::remote_pair_start,
            remote::remote_pair_cancel,
            remote::remote_device_remove,
            remote::remote_rpc_reply,
            remote::shared_get,
            remote::shared_set,
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
