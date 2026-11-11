// 생성 후 스크립트 실행기 (F-09, AC-16, EC-19, EC-21).
// 스크립트 본문을 UTF-8(BOM) 임시 파일로 저장해 플랫폼 기본 셸로 실행하고 stdout/stderr 를 라인 단위로 스트리밍한다.
//  - Windows: powershell -NoProfile -ExecutionPolicy Bypass -File <tmp>.ps1
//    프렐류드: $ErrorActionPreference='Stop' + UTF-8 출력, 에필로그: if ($LASTEXITCODE) { exit $LASTEXITCODE }
//    (PowerShell 은 중간 네이티브 명령이 실패해도 계속 진행한다 — 마지막 네이티브 종료 코드만 전달됨)
//  - 그 외: sh <tmp>.sh (프렐류드 set -e), 별도 프로세스 그룹
// 취소: Windows taskkill /PID <pid> /T /F, 그 외 프로세스 그룹 SIGTERM → 3초 후 SIGKILL
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct ScriptState {
    /// runId → pid
    running: Mutex<HashMap<String, u32>>,
    cancelled: Mutex<HashSet<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRunResult {
    exit_code: Option<i32>,
    cancelled: bool,
}

impl ScriptRunResult {
    pub(crate) fn cancelled() -> Self {
        Self {
            exit_code: None,
            cancelled: true,
        }
    }

    pub(crate) fn exited(code: i32) -> Self {
        Self {
            exit_code: Some(code),
            cancelled: false,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScriptLog {
    run_id: String,
    stream: &'static str,
    line: String,
}

pub(crate) fn safe_name(run_id: &str) -> String {
    run_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect()
}

fn write_script(run_id: &str, script: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("minmo-scripts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = safe_name(run_id);
    if cfg!(windows) {
        let path = dir.join(format!("{name}.ps1"));
        let body = format!(
            "$ErrorActionPreference = 'Stop'\r\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n$OutputEncoding = [System.Text.Encoding]::UTF8\r\n{}\r\nif ($LASTEXITCODE) {{ exit $LASTEXITCODE }}\r\n",
            script.replace("\r\n", "\n").replace('\n', "\r\n")
        );
        // BOM 이 있어야 Windows PowerShell 5.1 이 UTF-8 로 읽는다(한글 경로·문자열)
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(body.as_bytes());
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(path)
    } else {
        let path = dir.join(format!("{name}.sh"));
        std::fs::write(&path, format!("set -e\n{script}\n")).map_err(|e| e.to_string())?;
        Ok(path)
    }
}

fn build_command(path: &PathBuf, cwd: &str, env: &HashMap<String, String>) -> Command {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("powershell.exe");
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(path);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg(path);
        c
    };
    cmd.current_dir(cwd)
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(super::CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 취소 시 자식까지 한 번에 종료하도록 새 프로세스 그룹
        cmd.process_group(0);
    }
    cmd
}

pub(crate) fn pump<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    run_id: String,
    stream: &'static str,
    r: R,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(r);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf)
                        .trim_end_matches(['\r', '\n'])
                        .to_string();
                    let _ = app.emit(
                        "script-log",
                        ScriptLog {
                            run_id: run_id.clone(),
                            stream,
                            line,
                        },
                    );
                }
            }
        }
    })
}

pub(crate) fn kill_tree(pid: u32) {
    #[cfg(windows)]
    super::taskkill_tree(pid);
    #[cfg(not(windows))]
    {
        let group = format!("-{pid}");
        let _ = Command::new("kill").args(["-TERM", "--", &group]).status();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let _ = Command::new("kill")
                .args(["-KILL", "--", &group])
                .stderr(Stdio::null())
                .status();
        });
    }
}

#[tauri::command]
pub async fn script_run(
    app: AppHandle,
    state: State<'_, ScriptState>,
    run_id: String,
    cwd: String,
    script: String,
    env: HashMap<String, String>,
) -> Result<ScriptRunResult, String> {
    if state
        .cancelled
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&run_id)
    {
        return Ok(ScriptRunResult {
            exit_code: None,
            cancelled: true,
        });
    }
    let path = write_script(&run_id, &script)?;
    let mut child = build_command(&path, &cwd, &env)
        .spawn()
        .map_err(|e| format!("스크립트 실행 실패: {e}"))?;
    state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run_id.clone(), child.id());

    let out = child
        .stdout
        .take()
        .map(|s| pump(app.clone(), run_id.clone(), "stdout", s));
    let err = child
        .stderr
        .take()
        .map(|s| pump(app.clone(), run_id.clone(), "stderr", s));

    let status = tauri::async_runtime::spawn_blocking(move || {
        let st = child.wait();
        if let Some(h) = out {
            let _ = h.join();
        }
        if let Some(h) = err {
            let _ = h.join();
        }
        st
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());

    state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&run_id);
    let _ = std::fs::remove_file(&path);
    let cancelled = state
        .cancelled
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&run_id);
    let status = status?;
    if cancelled {
        return Ok(ScriptRunResult {
            exit_code: None,
            cancelled: true,
        });
    }
    Ok(ScriptRunResult {
        exit_code: Some(status.code().unwrap_or(-1)),
        cancelled: false,
    })
}

#[tauri::command]
pub fn script_cancel(state: State<'_, ScriptState>, run_id: String) -> Result<(), String> {
    state
        .cancelled
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run_id.clone());
    let pid = state
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .get(&run_id)
        .copied();
    if let Some(pid) = pid {
        kill_tree(pid);
    }
    Ok(())
}
