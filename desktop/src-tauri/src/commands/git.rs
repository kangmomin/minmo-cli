// git / gh 실행. non-zero 종료도 에러가 아니라 code 로 돌려준다(프론트가 stderr 로 분기).
use std::collections::HashMap;
use std::process::Stdio;

use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

async fn run(
    program: &str,
    args: &[String],
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    stdin: Option<String>,
) -> Result<CmdResult, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        // 자격 증명 프롬프트로 멈추지 않도록(실패로 끝나게) 한다
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    if let Some(vars) = env {
        cmd.envs(vars);
    }
    #[cfg(windows)]
    cmd.creation_flags(super::CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{program} 실행 실패: {e}"))?;
    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            pipe.write_all(input.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            drop(pipe);
        }
    }
    let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
    Ok(CmdResult {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

#[tauri::command]
pub async fn git_run(
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<CmdResult, String> {
    run("git", &args, cwd, env, None).await
}

#[tauri::command]
pub async fn gh_run(
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    stdin: Option<String>,
) -> Result<CmdResult, String> {
    run("gh", &args, cwd, env, stdin).await
}

/// gh 설치 + `gh auth status` 성공 여부 (EC-01)
#[tauri::command]
pub async fn gh_available() -> bool {
    run(
        "gh",
        &["auth".to_string(), "status".to_string()],
        None,
        None,
        None,
    )
    .await
    .map(|r| r.code == 0)
    .unwrap_or(false)
}
