// 터미널 PTY (F-04, AC-08). 세션별 cwd 를 기록해 worktree 삭제 전 pty_kill_by_cwd 로 선종료한다.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    cwd: String,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
    seq: AtomicU64,
}

#[derive(Clone, Serialize)]
struct PtyData {
    id: String,
    data: String,
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

/// 읽은 바이트에서 완전한 UTF-8 접두부만 문자열로 내보내고, 잘린 멀티바이트 꼬리는 다음 읽기로 넘긴다
fn take_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            out
        }
        Err(_) => {
            let out = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            out
        }
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(err)?;
    let mut cmd = CommandBuilder::new(default_shell());
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;
    let id = format!("pty-{}", state.seq.fetch_add(1, Ordering::SeqCst) + 1);

    let emit_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = take_utf8(&mut pending);
                    if !text.is_empty() {
                        let _ = app.emit(
                            "pty-data",
                            PtyData {
                                id: emit_id.clone(),
                                data: text,
                            },
                        );
                    }
                }
            }
        }
    });

    state.sessions.lock().map_err(err)?.insert(
        id.clone(),
        PtySession {
            master: pair.master,
            writer,
            child,
            cwd,
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(err)?;
    let s = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("pty {id} 없음"))?;
    s.writer.write_all(data.as_bytes()).map_err(err)?;
    s.writer.flush().map_err(err)
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(err)?;
    let s = sessions.get(&id).ok_or_else(|| format!("pty {id} 없음"))?;
    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(err)
}

fn kill_session(mut s: PtySession) {
    let _ = s.child.kill();
    let _ = s.child.wait();
    // master 를 drop 하면 ConPTY/pty 가 닫히고 리더 스레드도 끝난다
    drop(s.master);
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let removed = state.sessions.lock().map_err(err)?.remove(&id);
    if let Some(s) = removed {
        kill_session(s);
    }
    Ok(())
}

/// cwd 가 path(또는 하위)인 PTY 를 모두 종료하고 종료 개수를 돌려준다 (worktree 삭제 전 — Windows 파일 잠금 방지)
#[tauri::command]
pub fn pty_kill_by_cwd(state: State<'_, PtyState>, path: String) -> Result<u32, String> {
    let targets: Vec<PtySession> = {
        let mut sessions = state.sessions.lock().map_err(err)?;
        let ids: Vec<String> = sessions
            .iter()
            .filter(|(_, s)| super::is_same_or_inside(&s.cwd, &path))
            .map(|(id, _)| id.clone())
            .collect();
        ids.iter().filter_map(|id| sessions.remove(id)).collect()
    };
    let n = targets.len() as u32;
    for s in targets {
        kill_session(s);
    }
    Ok(n)
}
