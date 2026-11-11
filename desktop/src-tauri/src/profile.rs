// 앱 데이터 위치와 키체인 서비스 이름.
// debug 빌드에서는 MINMO_DESKTOP_PROFILE=<폴더> 로 둘 다 바꿔, 개발·E2E 실행이 사용자의 실제 데이터와 키체인을 건드리지 않게 한다.
use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

pub const KEYCHAIN_SERVICE: &str = "com.minmo.desktop";

fn profile_dir() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os("MINMO_DESKTOP_PROFILE")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// 격리 프로필로 실행 중인지 — 이때는 minmo:// 스킴을 시스템에 등록하지 않는다(설치된 앱의 딥링크를 가로채지 않게)
pub fn isolated() -> bool {
    profile_dir().is_some()
}

pub fn keychain_service() -> String {
    if isolated() {
        format!("{KEYCHAIN_SERVICE}.dev")
    } else {
        KEYCHAIN_SERVICE.to_string()
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
