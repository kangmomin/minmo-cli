// Tauri 진입점. invoke 이름은 desktop/src/lib/tauri.ts 의 TAURI_COMMANDS 와 1:1,
// 이벤트 이름은 TAURI_EVENTS("pty-data", "pty-link", "script-log", "server-status", "close-requested", "update-progress", "tailscale-log") 와 일치해야 한다.
mod commands;
mod profile;
mod remote;
mod server;
mod shell;
mod tailscale;
mod update;

use commands::{agent_models, agents, fs, git, keychain, pty, pty_reconnect, script, ssh, usage};
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
        .manage(tailscale::TailscaleState::default())
        .setup(|app| {
            // 키체인 서비스 이름이 identifier 를 따르므로 키체인을 쓰기 전에
            profile::init(&app.config().identifier);
            let handle = app.handle().clone();
            // 터미널 출력·종료 이벤트를 낼 곳과 원격 터미널의 재접속 감독 — 명령이 오기 전에(PtyState 는 위에서 등록)
            let ptys = app.state::<pty::PtyState>();
            ptys.attach(&handle);
            ptys.set_supervisor(pty_reconnect::supervise);
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
            // main 창만 — 다른 PC 의 화면을 여는 창(peer-*)이 뜰 때 이 PC 의 터미널을 끝내면 안 된다
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                // 보조 창(ws-*)이 떠 있으면 그 창들이 터미널을 쓰고 있다 — 다시 붙을 수 있는(패널 id 가 있는) 세션은 남긴다
                let ptys = webview.state::<pty::PtyState>();
                if shell::has_secondary_windows(webview.app_handle()) {
                    pty::kill_unkeyed(&ptys);
                } else {
                    pty::kill_all(&ptys);
                }
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
            pty::pty_windows,
            pty::pty_kill,
            pty::pty_kill_by_cwd,
            pty::pty_processes,
            pty_reconnect::pty_reconnect,
            agents::claude_subagents,
            usage::agent_usage,
            agent_models::agent_models_raw,
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
            fs::copy_paths,
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
            shell::app_show,
            shell::window_open,
            update::app_update_check,
            update::app_update_install,
            remote::remote_status,
            remote::remote_configure,
            remote::remote_pair_start,
            remote::remote_pair_cancel,
            remote::remote_device_remove,
            remote::remote_rpc_reply,
            remote::agents_publish,
            remote::peers_list,
            remote::device_name,
            remote::peer_add,
            remote::peer_remove,
            remote::peer_open,
            remote::shared_get,
            remote::shared_set,
            tailscale::tailscale_status,
            tailscale::tailscale_install,
            tailscale::tailscale_install_cancel,
            tailscale::tailscale_login,
            tailscale::tailscale_serve,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // 어떤 경로로 끝나든(트레이 종료·OS 종료 등) 서버를 정상 종료한다
        if let tauri::RunEvent::Exit = event {
            if let Some(mgr) = app.try_state::<server::ServerManager>() {
                mgr.shutdown(app);
            }
            tailscale::shutdown(app);
        }
    });
}
