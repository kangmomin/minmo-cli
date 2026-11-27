// TypeSafe Jev 판정(#122) — API 키는 OS 키체인에 두고 Rust 안에서만 읽는다(WEBVIEW_KEYS 에 넣지 않음).
// Why: 실패는 고정 오류 코드만 돌려준다 — 화면(features/answer/jev.ts)이 코드로 문구를 고르고, 오류 글에 키가 섞이지 않게
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::header::CONTENT_TYPE;

use super::keychain;

pub const JEV_KEY: &str = "minmo.jev-key";
const JEV_URL: &str = "https://api.typesafe.ai/v1/systemone";
/// 요청 본문 상한(UTF-8 바이트) — 화면은 60KiB 안으로 만든다
const MAX_BODY_BYTES: usize = 64 * 1024;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// 앞뒤 공백을 떼고, 비었거나 보이는 ASCII(0x21~0x7E) 밖 글자가 있으면 jev_key_invalid
/// Why: 줄바꿈·공백·한글이 들어가면 Bearer 헤더가 깨진다 — 화면(jevKey.ts)과 같은 검사
pub fn valid_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("jev_key_invalid".into());
    }
    Ok(key.to_string())
}

/// 보내기 전 확인 — 키가 없으면 jev_key_missing, 본문이 64KiB 를 넘으면 jev_too_large
pub fn prepare(key: Option<String>, body: String) -> Result<(String, String), String> {
    let key = key.filter(|k| !k.is_empty()).ok_or("jev_key_missing")?;
    if body.len() > MAX_BODY_BYTES {
        return Err("jev_too_large".into());
    }
    Ok((key, body))
}

pub fn error_code(status: u16) -> String {
    format!("jev_http_{status}")
}

/// 키체인 호출은 blocking 스레드에서 — 실패는 이유와 관계없이 jev_keychain
async fn with_keychain<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(Ok(v)) => Ok(v),
        _ => Err("jev_keychain".into()),
    }
}

/// body = 요청 JSON 글자 그대로, 돌려주는 값 = 응답 JSON 글자 그대로
#[tauri::command]
pub async fn jev_decide(body: String) -> Result<String, String> {
    let key = with_keychain(|| keychain::get(JEV_KEY)).await?;
    let (key, body) = prepare(key, body)?;
    let res = client()
        .post(JEV_URL)
        .bearer_auth(key)
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| "jev_network".to_string())?;
    let status = res.status();
    if !status.is_success() {
        return Err(error_code(status.as_u16()));
    }
    res.text().await.map_err(|_| "jev_network".to_string())
}

#[tauri::command]
pub async fn jev_key_status() -> Result<bool, String> {
    with_keychain(|| keychain::get(JEV_KEY).map(|v| v.is_some_and(|k| !k.is_empty()))).await
}

#[tauri::command]
pub async fn jev_key_set(key: String) -> Result<(), String> {
    let key = valid_key(&key)?;
    with_keychain(move || keychain::set(JEV_KEY, &key)).await
}

#[tauri::command]
pub async fn jev_key_delete() -> Result<(), String> {
    with_keychain(|| keychain::delete(JEV_KEY)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_needs_a_key_and_a_small_body() {
        assert_eq!(prepare(None, "{}".into()), Err("jev_key_missing".to_string()));
        assert_eq!(prepare(Some(String::new()), "{}".into()), Err("jev_key_missing".to_string()));
        assert_eq!(prepare(Some("k".into()), "{}".into()), Ok(("k".to_string(), "{}".to_string())));
        assert!(prepare(Some("k".into()), "a".repeat(MAX_BODY_BYTES)).is_ok());
        assert_eq!(prepare(Some("k".into()), "a".repeat(MAX_BODY_BYTES + 1)), Err("jev_too_large".to_string()));
        assert_eq!(prepare(Some("k".into()), "가".repeat(MAX_BODY_BYTES / 3 + 1)), Err("jev_too_large".to_string()));
    }

    #[test]
    fn error_code_carries_the_http_status() {
        assert_eq!(error_code(401), "jev_http_401");
        assert_eq!(error_code(529), "jev_http_529");
    }

    #[test]
    fn valid_key_trims_and_rejects_invisible_or_non_ascii() {
        assert_eq!(valid_key("  sk-abc  "), Ok("sk-abc".to_string()));
        assert_eq!(valid_key("sk-test-123\n"), Ok("sk-test-123".to_string()));
        for bad in ["", "   ", "sk-a\nb", "sk a", "키에-한글", "sk-\u{7f}"] {
            assert_eq!(valid_key(bad), Err("jev_key_invalid".to_string()), "{bad:?}");
        }
    }

    #[test]
    fn jev_key_is_not_a_webview_key() {
        assert!(keychain::keychain_get(JEV_KEY.into()).is_err());
    }
}
