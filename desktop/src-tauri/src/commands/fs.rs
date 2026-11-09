// 파일 시스템·플랫폼 정보
use std::path::{Component, Path};

use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn home_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// 프론트 Platform 타입과 같은 값 ('win32' | 'darwin' | 'linux')
#[tauri::command]
pub fn os_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// 재귀 삭제 — EC-10 "이번 실행이 새로 만든 경로" 정리 전용.
/// 실수로 넓은 범위를 지우지 않도록 상대 경로·루트·홈 디렉터리와 얕은 경로(구성 요소 3개 미만)는 거부한다.
#[tauri::command]
pub fn remove_dir(app: AppHandle, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_absolute() {
        return Err(format!("절대 경로만 삭제할 수 있습니다: {path}"));
    }
    let depth = p.components().filter(|c| matches!(c, Component::Normal(_))).count();
    if depth < 3 {
        return Err(format!("너무 상위 경로라 삭제하지 않습니다: {path}"));
    }
    if let Ok(home) = app.path().home_dir() {
        if super::normalize_path(&home.to_string_lossy()) == super::normalize_path(&path) {
            return Err("홈 디렉터리는 삭제하지 않습니다".to_string());
        }
    }
    if !p.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(p).map_err(|e| e.to_string())
}
