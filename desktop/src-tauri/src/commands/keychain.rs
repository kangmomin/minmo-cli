// OS 키체인. 웹뷰 명령(세션 토큰·GitHub 토큰)은 허용 키만 다루고, 실패는 문자열 에러로 돌려주면
// 프론트가 "세션이 저장되지 않음" 배너로 폴백한다. 서버 비밀 값(server.rs)은 Rust 안에서만 읽고 쓴다.
use crate::profile::keychain_service;

/// 웹뷰가 다룰 수 있는 키 — desktop/src/lib/tauri.ts 의 KEYCHAIN_KEYS 와 같다
const WEBVIEW_KEYS: [&str; 2] = ["minmo.session", "minmo.github-token"];

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(&keychain_service(), key).map_err(|e| e.to_string())
}

fn webview_key(key: &str) -> Result<&str, String> {
    if WEBVIEW_KEYS.contains(&key) {
        Ok(key)
    } else {
        Err(format!("허용되지 않은 키체인 키입니다: {key}"))
    }
}

pub(crate) fn get(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub(crate) fn set(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(|e| e.to_string())
}

pub(crate) fn delete(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn keychain_get(key: String) -> Result<Option<String>, String> {
    get(webview_key(&key)?)
}

#[tauri::command]
pub fn keychain_set(key: String, value: String) -> Result<(), String> {
    set(webview_key(&key)?, &value)
}

#[tauri::command]
pub fn keychain_delete(key: String) -> Result<(), String> {
    delete(webview_key(&key)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webview_cannot_touch_server_secrets() {
        assert!(webview_key("minmo.session").is_ok());
        assert!(webview_key("minmo.github-token").is_ok());
        assert!(webview_key("minmo.server.github-client-secret").is_err());
        assert!(webview_key("minmo.server.token-key").is_err());
        assert!(keychain_get("minmo.server.token-key".into()).is_err());
    }
}
