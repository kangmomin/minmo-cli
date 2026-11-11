// 앱 자동 업데이트 — 릴리즈의 latest.json 을 확인하고, 서명을 검증한 설치 파일로 업데이트한다.
// 설치 전에 내장 서버를 정상 종료한다: 설치 파일이 minmo-server.exe 를 덮어써야 하고, Windows 는 설치 파일을
// 실행한 뒤 곧바로 std::process::exit 로 끝나 RunEvent::Exit 정리가 돌지 않는다(설치가 끝나면 앱을 다시 실행한다).
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::server::ServerManager;

pub const PROGRESS_EVENT: &str = "update-progress";

/// 확인한 업데이트 — 설치 때 같은 것을 쓴다
#[derive(Default)]
pub struct UpdateState(Mutex<Option<Update>>);

impl UpdateState {
    fn set(&self, update: Option<Update>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = update;
    }

    fn get(&self) -> Option<Update> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// 확인할 곳 — release 는 설정(tauri.conf.json)의 엔드포인트,
/// debug 는 E2E override(MINMO_UPDATER_ENDPOINT·MINMO_UPDATER_PUBKEY)가 있을 때만(개발 중 실제 릴리즈를 알리지 않게)
#[derive(Debug, PartialEq, Eq)]
enum Source {
    Configured,
    Override {
        endpoint: String,
        pubkey: Option<String>,
    },
    Skip,
}

fn source(debug: bool, env: impl Fn(&str) -> Option<String>) -> Source {
    if !debug {
        return Source::Configured;
    }
    match env("MINMO_UPDATER_ENDPOINT").filter(|v| !v.is_empty()) {
        Some(endpoint) => Source::Override {
            endpoint,
            pubkey: env("MINMO_UPDATER_PUBKEY").filter(|v| !v.is_empty()),
        },
        None => Source::Skip,
    }
}

fn info(version: &str, current: &str, notes: Option<&str>, raw: &serde_json::Value) -> UpdateInfo {
    UpdateInfo {
        version: version.to_string(),
        current_version: current.to_string(),
        notes: notes.map(str::to_string).filter(|n| !n.trim().is_empty()),
        date: raw
            .get("pub_date")
            .and_then(|d| d.as_str())
            .map(str::to_string),
    }
}

#[tauri::command]
pub async fn app_update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let mut builder = app.updater_builder();
    match source(cfg!(debug_assertions), |k| std::env::var(k).ok()) {
        Source::Skip => return Ok(None),
        Source::Configured => {}
        Source::Override { endpoint, pubkey } => {
            let url = endpoint
                .parse()
                .map_err(|e| format!("업데이트 주소가 올바르지 않습니다: {e}"))?;
            builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
            if let Some(key) = pubkey {
                builder = builder.pubkey(key);
            }
        }
    }
    let update = builder
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("업데이트를 확인하지 못했습니다: {e}"))?;
    let result = update.as_ref().map(|u| {
        info(
            &u.version,
            &u.current_version,
            u.body.as_deref(),
            &u.raw_json,
        )
    });
    app.state::<UpdateState>().set(update);
    Ok(result)
}

#[tauri::command]
pub async fn app_update_install(app: AppHandle) -> Result<(), String> {
    let update = app
        .state::<UpdateState>()
        .get()
        .ok_or_else(|| "확인된 업데이트가 없습니다 — 업데이트를 다시 확인하세요".to_string())?;
    let emitter = app.clone();
    let mut downloaded = 0u64;
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = emitter.emit(PROGRESS_EVENT, Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| format!("업데이트를 받지 못했습니다: {e}"))?;

    // 서버 정지는 몇 초 걸릴 수 있어 블로킹 풀에서
    let stopper = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        stopper.state::<ServerManager>().shutdown(&stopper);
    })
    .await
    .map_err(|e| e.to_string())?;

    // Windows: 설치 파일을 실행하고 이 프로세스를 끝낸다(돌아오면 실패)
    if let Err(e) = update.install(bytes) {
        ServerManager::resume(&app);
        return Err(format!("업데이트를 설치하지 못했습니다: {e}"));
    }
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_always_uses_configured_endpoint() {
        let env = |_: &str| Some("http://127.0.0.1:1/latest.json".to_string());
        assert_eq!(source(false, env), Source::Configured);
    }

    #[test]
    fn debug_checks_only_with_override() {
        assert_eq!(source(true, |_| None), Source::Skip);
        assert_eq!(source(true, |_| Some(String::new())), Source::Skip);
        let env = |k: &str| match k {
            "MINMO_UPDATER_ENDPOINT" => Some("http://127.0.0.1:8799/latest.json".to_string()),
            "MINMO_UPDATER_PUBKEY" => Some("pk".to_string()),
            _ => None,
        };
        assert_eq!(
            source(true, env),
            Source::Override {
                endpoint: "http://127.0.0.1:8799/latest.json".into(),
                pubkey: Some("pk".into())
            }
        );
    }

    #[test]
    fn info_maps_notes_and_date() {
        let raw = serde_json::json!({ "pub_date": "2026-11-11T00:00:00Z" });
        let i = info("0.4.1", "0.4.0", Some("변경 사항"), &raw);
        assert_eq!(i.version, "0.4.1");
        assert_eq!(i.current_version, "0.4.0");
        assert_eq!(i.notes.as_deref(), Some("변경 사항"));
        assert_eq!(i.date.as_deref(), Some("2026-11-11T00:00:00Z"));
        assert_eq!(
            info("1", "0", Some("  "), &serde_json::json!({})).notes,
            None
        );
    }
}
