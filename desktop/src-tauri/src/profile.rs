// 앱 데이터 위치와 키체인 서비스 이름.
// 키체인 서비스는 앱 identifier 를 따른다(identifier 를 바꾼 E2E 설치본이 실제 앱의 키체인을 쓰지 않게).
// debug 빌드에서는 MINMO_DESKTOP_PROFILE=<폴더> 로 둘 다 바꿔, 개발·E2E 실행이 사용자의 실제 데이터와 키체인을 건드리지 않게 한다.
use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::{AppHandle, Manager, Runtime};

pub const KEYCHAIN_SERVICE: &str = "com.minmo.desktop";

static IDENTIFIER: OnceLock<String> = OnceLock::new();

/// 앱 시작 시(setup) 한 번 — 키체인을 쓰기 전에 부른다
pub fn init(identifier: &str) {
    let _ = IDENTIFIER.set(identifier.to_string());
}

fn profile_dir() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os("MINMO_DESKTOP_PROFILE")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// 격리 프로필로 실행 중인지 — 이때는 키체인 서비스 이름을 따로 쓴다(설치된 앱의 값과 섞이지 않게)
pub fn isolated() -> bool {
    profile_dir().is_some()
}

pub fn keychain_service() -> String {
    service_name(IDENTIFIER.get().map(String::as_str), isolated())
}

fn service_name(identifier: Option<&str>, isolated: bool) -> String {
    let base = identifier.unwrap_or(KEYCHAIN_SERVICE);
    if isolated {
        format!("{base}.dev")
    } else {
        base.to_string()
    }
}

pub struct Dirs {
    /// server.json
    pub config: PathBuf,
    /// 서버 DB
    pub data: PathBuf,
    /// server.log
    pub logs: PathBuf,
}

pub fn dirs<R: Runtime>(app: &AppHandle<R>) -> Result<Dirs, String> {
    if let Some(p) = profile_dir() {
        return Ok(Dirs {
            config: p.clone(),
            data: p.clone(),
            logs: p.join("logs"),
        });
    }
    let path = app.path();
    let err = |e: tauri::Error| format!("앱 데이터 폴더를 찾을 수 없습니다: {e}");
    Ok(Dirs {
        config: path.app_config_dir().map_err(err)?,
        data: path.app_data_dir().map_err(err)?,
        logs: path.app_log_dir().map_err(err)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_service_follows_identifier() {
        assert_eq!(
            service_name(Some("com.minmo.desktop"), false),
            "com.minmo.desktop"
        );
        assert_eq!(
            service_name(Some("com.minmo.desktop.e2e"), false),
            "com.minmo.desktop.e2e"
        );
        assert_eq!(
            service_name(Some("com.minmo.desktop.e2e"), true),
            "com.minmo.desktop.e2e.dev"
        );
        assert_eq!(service_name(None, false), KEYCHAIN_SERVICE);
    }
}
