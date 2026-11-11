// 트레이와 창 닫기 — 창을 닫을 때 트레이로 숨길지(서버 유지, 원격 CLI 계속 사용) 앱을 끝낼지 사용자가 고른다.
// 고른 방식은 server.json 의 closeAction(ask·tray·quit)에 두고, ask 면 웹뷰에 물어본다(close-requested 이벤트).
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};

use crate::server::{CloseAction, ServerManager, State, Status};

pub const CLOSE_REQUESTED_EVENT: &str = "close-requested";
const TRAY_ID: &str = "main";

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// 서버를 정상 종료한 뒤 앱을 끝낸다(서버 정지가 몇 초 걸릴 수 있어 별도 스레드)
pub fn quit(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(mgr) = app.try_state::<ServerManager>() {
            mgr.shutdown(&app);
        }
        app.exit(0);
    });
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "열기", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit_item])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("minmo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn tooltip(status: &Status) -> String {
    let addr = format!("127.0.0.1:{}", status.port);
    match status.state {
        State::Running => format!("minmo — 서버 실행 중 ({addr})"),
        State::Starting => format!("minmo — 서버 시작 중 ({addr})"),
        State::Failed => "minmo — 서버 오류".to_string(),
        State::Stopped => "minmo — 서버 정지".to_string(),
        State::External => "minmo — 외부 서버".to_string(),
    }
}

pub fn set_tray_tooltip(app: &AppHandle, status: &Status) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip(status)));
    }
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    let action = app
        .try_state::<ServerManager>()
        .map(|m| m.settings().close_action)
        .unwrap_or_default();
    // 어느 경우든 기본 닫기는 막는다 — 종료도 서버를 먼저 정상 종료한 뒤 앱을 끝낸다
    api.prevent_close();
    match action {
        CloseAction::Tray => hide_main(app),
        CloseAction::Quit => quit(app),
        CloseAction::Ask => {
            // 물어본 지 얼마 안 돼 다시 닫으면 종료한다 — 웹뷰가 멈춰(새로 고침 중·응답 없음) 대화상자를 못 띄워도 끝낼 수 있게
            if ask_again(&mut lock_last_ask(), Instant::now()) {
                quit(app);
            } else {
                let _ = window.emit(CLOSE_REQUESTED_EVENT, ());
            }
        }
    }
}

static LAST_ASK: Mutex<Option<Instant>> = Mutex::new(None);
const ASK_AGAIN_WITHIN: Duration = Duration::from_secs(3);

fn lock_last_ask() -> std::sync::MutexGuard<'static, Option<Instant>> {
    LAST_ASK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 직전 물음에서 ASK_AGAIN_WITHIN 안에 다시 닫았는지. 아니면 이번 물음 시각을 기록한다
fn ask_again(last: &mut Option<Instant>, now: Instant) -> bool {
    if last.is_some_and(|t| now.duration_since(t) < ASK_AGAIN_WITHIN) {
        *last = None;
        true
    } else {
        *last = Some(now);
        false
    }
}

/// 닫기 대화상자의 선택. remember 면 다음부터 묻지 않도록 저장한다(저장에 실패해도 고른 동작은 한다)
#[tauri::command]
pub fn app_close(app: AppHandle, action: CloseAction, remember: bool) -> Result<(), String> {
    *lock_last_ask() = None;
    let saved = if remember {
        app.state::<ServerManager>().save_close_action(&app, action)
    } else {
        Ok(())
    };
    match action {
        CloseAction::Tray => hide_main(&app),
        CloseAction::Quit => quit(&app),
        CloseAction::Ask => {}
    }
    saved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_close_within_window_quits() {
        let t0 = Instant::now();
        let mut last = None;
        assert!(!ask_again(&mut last, t0), "첫 닫기는 묻는다");
        assert!(
            ask_again(&mut last, t0 + Duration::from_secs(1)),
            "3초 안에 다시 닫으면 종료"
        );
        assert!(
            !ask_again(&mut last, t0 + Duration::from_secs(2)),
            "종료 판정 뒤에는 다시 묻는다"
        );
        assert!(
            !ask_again(&mut last, t0 + Duration::from_secs(10)),
            "오래 지나면 다시 묻는다"
        );
    }

    #[test]
    fn tooltip_shows_address_while_running() {
        let s = |state| Status {
            state,
            port: 18787,
            message: None,
        };
        assert_eq!(
            tooltip(&s(State::Running)),
            "minmo — 서버 실행 중 (127.0.0.1:18787)"
        );
        assert_eq!(tooltip(&s(State::Failed)), "minmo — 서버 오류");
    }
}
