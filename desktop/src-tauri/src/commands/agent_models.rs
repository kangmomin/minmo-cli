// CLI 별 모델 목록 원문(E2E 큐 역할 설정). 파싱은 화면(features/e2eQueue/models.ts)이 한다 — CLI 출력 형식이 바뀌어도
// 앱을 다시 빌드하지 않고 파서만 고치면 되게.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_STDOUT: usize = 8 * 1024 * 1024;
/// 오류 문구에는 첫 줄만 쓰므로 많이 읽지 않는다
const MAX_STDERR: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Claude,
    Codex,
    Gemini,
}

/// 고정 값만 받는다 — 그대로 명령줄(`cmd /C`)에 들어가므로 사용자 입력이 섞이면 안 된다
fn parse_kind(kind: &str) -> Result<Kind, String> {
    match kind {
        "claude" => Ok(Kind::Claude),
        "codex" => Ok(Kind::Codex),
        "gemini" => Ok(Kind::Gemini),
        _ => Err(format!("모델 목록을 가져올 수 없는 CLI 입니다: {kind}")),
    }
}

/// 그 CLI 의 모델 목록 원문. claude 는 `{"catalog":…,"masked":…}` JSON(캐시가 없으면 빈 문자열)
#[tauri::command]
pub async fn agent_models_raw(kind: String) -> Result<String, String> {
    match parse_kind(&kind)? {
        Kind::Claude => {
            let Some(dir) = claude_catalog_dir() else {
                return Ok(String::new());
            };
            tauri::async_runtime::spawn_blocking(move || claude_models_raw(&dir))
                .await
                .map_err(|e| e.to_string())?
        }
        Kind::Codex => {
            let out = run_cli("codex", &["debug", "models"]).await?;
            out.ok("codex")
        }
        Kind::Gemini => {
            let out = run_cli("gemini", &["models", "list", "-o", "json"]).await?;
            if out.code == 0 && looks_like_json(&out.stdout) {
                return Ok(out.stdout);
            }
            if out.not_found() {
                return out.ok("gemini");
            }
            // JSON 출력을 모르는 버전 — 텍스트 목록으로
            run_cli("gemini", &["--list-models"]).await?.ok("gemini")
        }
    }
}

// ── Claude: CLI 에 목록 명령이 없어 Claude Code 가 받아 둔 캐시를 읽는다 ──

/// CLAUDE_CONFIG_DIR(없으면 ~/.claude)/cache/model-catalog
fn claude_catalog_dir() -> Option<PathBuf> {
    let base = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var_os(if cfg!(windows) {
            "USERPROFILE"
        } else {
            "HOME"
        })?)
        .join(".claude"),
    };
    Some(base.join("cache").join("model-catalog"))
}

/// 가장 최근에 바뀐 `*-cc.json` — `tok-*-ccd.json`·`published-*.json` 은 다른 용도의 캐시다
fn latest_catalog(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.ends_with("-cc.json"))
                && e.file_type().is_ok_and(|t| t.is_file())
        })
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .max_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)))
        .map(|(_, p)| p)
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn claude_models_raw(dir: &Path) -> Result<String, String> {
    let Some(path) = latest_catalog(dir) else {
        return Ok(String::new());
    };
    let catalog = read_json(&path).ok_or_else(|| {
        format!(
            "Claude 모델 목록 캐시를 읽지 못했습니다: {}",
            path.display()
        )
    })?;
    // 숨김 목록은 없거나 깨져도 목록 전체를 보여 주면 된다
    let masked = read_json(&dir.join("masked-ids.json")).unwrap_or(Value::Null);
    Ok(serde_json::json!({ "catalog": catalog, "masked": masked }).to_string())
}

// ── codex · gemini: CLI 실행 ──

struct CliOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

impl CliOutput {
    /// 셸이 명령을 찾지 못함(Unix 127, Windows cmd 9009)
    fn not_found(&self) -> bool {
        self.code == 127 || (cfg!(windows) && self.code == 9009)
    }

    fn ok(self, cli: &str) -> Result<String, String> {
        if self.code == 0 {
            return Ok(self.stdout);
        }
        if self.not_found() {
            return Err(format!("{cli} 를 찾지 못했습니다 — PATH 를 확인하세요"));
        }
        let line = first_line(&self.stderr).or_else(|| first_line(&self.stdout));
        Err(match line {
            Some(l) => format!("{cli} 실행 실패: {l}"),
            None => format!("{cli} 실행 실패(종료 코드 {})", self.code),
        })
    }
}

fn first_line(s: &str) -> Option<&str> {
    s.lines().map(str::trim).find(|l| !l.is_empty())
}

/// 앞뒤에 경고 줄이 섞여도 첫 `{`·`[` 부터 마지막 `}`·`]` 까지가 JSON 이면 된다(화면 파서와 같은 기준)
fn looks_like_json(s: &str) -> bool {
    let (Some(start), Some(end)) = (s.find(['{', '[']), s.rfind(['}', ']'])) else {
        return false;
    };
    end > start && serde_json::from_str::<Value>(&s[start..=end]).is_ok()
}

#[cfg_attr(windows, allow(dead_code))]
fn is_posix_shell(path: &str) -> bool {
    let name = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    matches!(name, "sh" | "bash" | "zsh" | "dash" | "ksh")
}

/// 앱을 Dock·런처에서 띄우면 PATH 에 사용자가 설치한 CLI 가 없을 수 있다 — 로그인 셸로 profile 을 읽고 실행한다.
/// fish·csh 등은 `-c` 문법이 달라 /bin/sh 로
#[cfg(not(windows))]
fn cli_command(cli: &str, args: &[&str]) -> Command {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| is_posix_shell(s))
        .unwrap_or_else(|| "/bin/sh".to_string());
    let mut cmd = Command::new(shell);
    cmd.args(["-lc", "exec \"$@\"", "sh", cli]).args(args);
    cmd
}

/// npm 으로 설치한 CLI 는 `.cmd` 이라 cmd 를 거쳐야 PATHEXT 로 찾는다
#[cfg(windows)]
fn cli_command(cli: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", cli]).args(args);
    cmd.creation_flags(super::CREATE_NO_WINDOW);
    cmd
}

async fn read_capped<R: AsyncRead + Unpin>(
    r: Option<R>,
    cap: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut buf = Vec::new();
    let Some(r) = r else {
        return Ok((buf, false));
    };
    // 한 바이트 더 읽어 상한을 넘었는지 안다
    r.take(cap as u64 + 1).read_to_end(&mut buf).await?;
    let over = buf.len() > cap;
    buf.truncate(cap);
    Ok((buf, over))
}

async fn run_cli(cli: &str, args: &[&str]) -> Result<CliOutput, String> {
    let mut cmd = cli_command(cli, args);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("{cli} 실행 실패: {e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let work = async {
        let (out, err) = tokio::join!(
            read_capped(stdout, MAX_STDOUT),
            read_capped(stderr, MAX_STDERR)
        );
        let (out, over) = out.map_err(|e| e.to_string())?;
        if over {
            return Err(format!("{cli} 의 출력이 너무 큽니다(8MB 초과)"));
        }
        let err = err.map(|(b, _)| b).unwrap_or_default();
        let status = child.wait().await.map_err(|e| e.to_string())?;
        Ok(CliOutput {
            code: status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
        })
    };
    let result = match tokio::time::timeout(TIMEOUT, work).await {
        Ok(r) => r,
        Err(_) => Err(format!("{cli} 가 30초 안에 끝나지 않았습니다")),
    };
    // 실패로 끝내면 child 는 kill_on_drop 으로 죽지만, Windows 는 cmd.exe 만 죽어 node 가 남는다 — 자손까지 끝낸다
    #[cfg(windows)]
    if result.is_err() {
        if let Some(pid) = pid {
            let _ = tauri::async_runtime::spawn_blocking(move || super::taskkill_tree(pid)).await;
        }
    }
    #[cfg(not(windows))]
    let _ = pid;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, SystemTime};

    fn tmp(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("minmo-agent-models-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 내용을 쓰고 mtime 을 지금으로부터 secs_ago 초 전으로 맞춘다
    fn write_at(dir: &Path, name: &str, content: &str, secs_ago: u64) {
        let p = dir.join(name);
        fs::write(&p, content).unwrap();
        let f = fs::File::options().write(true).open(&p).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(secs_ago))
            .unwrap();
    }

    #[test]
    fn agent_models_kind_only_known_clis() {
        assert_eq!(parse_kind("claude"), Ok(Kind::Claude));
        assert_eq!(parse_kind("codex"), Ok(Kind::Codex));
        assert_eq!(parse_kind("gemini"), Ok(Kind::Gemini));
        for bad in ["", "custom", "Claude", "codex & calc", "bash"] {
            assert!(parse_kind(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn agent_models_latest_cc_catalog_ignores_ccd_and_published() {
        let d = tmp("latest");
        write_at(&d, "old-cc.json", r#"{"v":"old"}"#, 300);
        write_at(&d, "new-cc.json", r#"{"v":"new"}"#, 100);
        // 더 최근이어도 다른 용도의 캐시는 고르지 않는다
        write_at(&d, "tok-abc-ccd.json", r#"{"v":"ccd"}"#, 0);
        write_at(&d, "published-floor.json", r#"{"v":"pub"}"#, 0);
        write_at(&d, "masked-ids.json", r#"{"ids":[]}"#, 0);
        fs::create_dir_all(d.join("dir-cc.json")).unwrap();
        assert_eq!(latest_catalog(&d), Some(d.join("new-cc.json")));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn agent_models_claude_bundles_catalog_and_masked() {
        let d = tmp("bundle");
        write_at(
            &d,
            "a-cc.json",
            r#"{"catalog":{"config":{"models":[{"id":"m1","name":"M1"}]}}}"#,
            0,
        );
        write_at(&d, "masked-ids.json", r#"{"version":1,"ids":["m2"]}"#, 0);
        let v: Value = serde_json::from_str(&claude_models_raw(&d).unwrap()).unwrap();
        assert_eq!(v["catalog"]["catalog"]["config"]["models"][0]["id"], "m1");
        assert_eq!(v["masked"]["ids"][0], "m2");

        // masked 가 없거나 깨졌으면 null
        fs::write(d.join("masked-ids.json"), "not json").unwrap();
        let v: Value = serde_json::from_str(&claude_models_raw(&d).unwrap()).unwrap();
        assert!(v["masked"].is_null());
        fs::remove_file(d.join("masked-ids.json")).unwrap();
        let v: Value = serde_json::from_str(&claude_models_raw(&d).unwrap()).unwrap();
        assert!(v["masked"].is_null());

        // catalog 가 깨졌으면 오류
        fs::write(d.join("a-cc.json"), "{").unwrap();
        assert!(claude_models_raw(&d).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn agent_models_claude_without_cache_is_empty() {
        let d = tmp("empty");
        assert_eq!(claude_models_raw(&d), Ok(String::new()));
        assert_eq!(claude_models_raw(&d.join("missing")), Ok(String::new()));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn agent_models_json_detection_and_errors() {
        assert!(looks_like_json(r#"[{"modelId":"g"}]"#));
        assert!(looks_like_json("Warning: x\n{\"models\":[]}\n"));
        assert!(!looks_like_json("gemini-2.5-pro (Gemini 2.5 Pro)"));
        assert!(!looks_like_json("Unknown argument: -o"));

        let out = |code: i32, stderr: &str| CliOutput {
            code,
            stdout: String::new(),
            stderr: stderr.into(),
        };
        assert_eq!(
            out(127, "sh: codex: not found").ok("codex"),
            Err("codex 를 찾지 못했습니다 — PATH 를 확인하세요".into())
        );
        assert_eq!(
            out(1, "\n  boom\nmore").ok("codex"),
            Err("codex 실행 실패: boom".into())
        );
        assert_eq!(
            out(2, "").ok("codex"),
            Err("codex 실행 실패(종료 코드 2)".into())
        );
    }

    #[test]
    fn agent_models_posix_shell_names() {
        for s in ["/bin/sh", "/bin/bash", "/usr/bin/zsh", "dash", "/bin/ksh"] {
            assert!(is_posix_shell(s), "{s}");
        }
        for s in ["/usr/bin/fish", "/bin/csh", "/bin/tcsh", "nu", ""] {
            assert!(!is_posix_shell(s), "{s}");
        }
    }
}
