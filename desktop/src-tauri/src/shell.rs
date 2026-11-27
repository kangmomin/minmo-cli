// 트레이와 창 닫기 — 창을 닫을 때 트레이로 숨길지(서버 유지, 원격 CLI 계속 사용) 앱을 끝낼지 사용자가 고른다.
// 고른 방식은 server.json 의 closeAction(ask·tray·quit)에 두고, ask 면 웹뷰에 물어본다(close-requested 이벤트).
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

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

/// 알림을 눌렀을 때 화면이 부른다 — 트레이로 숨긴 창도 앞으로 가져온다
#[tauri::command]
pub fn app_show(app: AppHandle) {
    show_main(&app);
}

fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// 서버를 정상 종료하고 터미널의 ConPTY 를 닫은 뒤 앱을 끝낸다(둘 다 몇 초 걸릴 수 있어 메인 스레드가 아닌 별도 스레드)
pub fn quit(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(mgr) = app.try_state::<ServerManager>() {
            mgr.shutdown(&app);
        }
        crate::commands::pty::close_all(&app.state::<crate::commands::pty::PtyState>());
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
        State::External => match status.url.as_deref() {
            Some(url) => format!("minmo — 서버 {}", url.trim_start_matches("https://")),
            None => "minmo — 외부 서버".to_string(),
        },
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
                // 대화상자는 main 창만 띄운다(emit 은 모든 창에 가므로 보조 창까지 대화상자를 띄운다)
                let _ = window.emit_to("main", CLOSE_REQUESTED_EVENT, ());
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
        let s = |state| Status::new(state, 18787, None);
        assert_eq!(
            tooltip(&s(State::Running)),
            "minmo — 서버 실행 중 (127.0.0.1:18787)"
        );
        assert_eq!(tooltip(&s(State::Failed)), "minmo — 서버 오류");
    }

    #[test]
    fn tooltip_shows_hosted_server() {
        let mut s = Status::new(State::External, 18787, None);
        s.url = Some("https://minmo.example".into());
        assert_eq!(tooltip(&s), "minmo — 서버 minmo.example");
        s.url = None;
        assert_eq!(tooltip(&s), "minmo — 외부 서버");
    }
}

/// 보조 창(같은 앱 화면을 하나 더 띄운 창)의 label 접두어 — capabilities 의 "ws-*" 와 맞춘다
pub const SECONDARY_PREFIX: &str = "ws-";
static NEXT_WINDOW: AtomicU32 = AtomicU32::new(1);

/// 화면이 넘긴 범위 값은 URL 에 그대로 붙이므로 퍼센트 인코딩된 문자만 받는다(다른 쿼리·경로를 끼워 넣지 못하게)
fn valid_scope(scope: &str) -> bool {
    scope.len() <= 1024
        && scope
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'%' | b'-' | b'_' | b'.' | b'~'))
}

fn window_title(title: Option<&str>) -> String {
    match title.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => format!("minmo — {}", t.chars().take(80).collect::<String>()),
        None => "minmo".to_string(),
    }
}

/// 같은 앱 화면을 새 창으로 연다(이슈 #105). scope 가 있으면 그 조직·저장소·그룹만 보인다.
/// 누를 때마다 새 창을 연다. async 여야 한다 — Windows 에서는 메인 스레드(동기 명령)에서 창을 만들면 멈춘다.
#[tauri::command]
pub async fn window_open(app: AppHandle, scope: Option<String>, title: Option<String>) -> Result<(), String> {
    let mut url = String::from("index.html?window=ws");
    if let Some(scope) = scope.as_deref().filter(|s| !s.is_empty()) {
        if !valid_scope(scope) {
            return Err("창 범위가 올바르지 않습니다".into());
        }
        url.push_str("&scope=");
        url.push_str(scope);
    }
    // 앞서 연 창이 아직 그 label 을 쓰고 있으면 다음 번호로 넘어간다
    let label = loop {
        let label = format!("{SECONDARY_PREFIX}{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
        if app.get_webview_window(&label).is_none() {
            break label;
        }
    };
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(window_title(title.as_deref()))
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 600.0)
        // main 과 같게 — 가려진 창에서도 터미널·에이전트 추적의 타이머가 느려지지 않게
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 보조 창이 하나라도 떠 있는가 — main 을 새로 고칠 때 그 창들의 터미널을 끝내지 않기 위해
pub fn has_secondary_windows(app: &AppHandle) -> bool {
    app.webview_windows().keys().any(|l| l.starts_with(SECONDARY_PREFIX))
}

#[cfg(test)]
mod window_tests {
    use super::*;

    #[test]
    fn scope_accepts_only_percent_encoded() {
        assert!(valid_scope("org%3Aacme"));
        assert!(valid_scope("repo%3Aacme%2Fapi.v2"));
        assert!(!valid_scope("org:acme"));
        assert!(!valid_scope("a&window=main"));
        assert!(!valid_scope("../x"));
        assert!(!valid_scope(&"a".repeat(1025)));
    }

    #[test]
    fn title_falls_back_and_truncates() {
        assert_eq!(window_title(None), "minmo");
        assert_eq!(window_title(Some("  ")), "minmo");
        assert_eq!(window_title(Some("acme")), "minmo — acme");
        assert_eq!(window_title(Some(&"x".repeat(100))).chars().count(), "minmo — ".chars().count() + 80);
    }
}
