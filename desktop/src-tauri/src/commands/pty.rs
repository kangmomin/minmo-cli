// 터미널 PTY (F-04, AC-08). 세션별 cwd 를 기록해 worktree 삭제 전 pty_kill_by_cwd 로 선종료한다.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::ssh;

/// 원격 터미널 요청. session 이 있으면 전용 tmux(-L minmo) 세션에 붙고, 없으면 로그인 셸을 연다
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePty {
    host: String,
    session: Option<String>,
    /// 분할로 만든 추가 패널 — 붙은 클라이언트가 없어지면 세션도 사라진다
    #[serde(default)]
    ephemeral: bool,
}

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    cwd: String,
    /// 원격(ssh) 세션이면 호스트 별칭 — 이때 cwd 는 원격 경로다
    host: Option<String>,
    /// ConPTY 시작 커서 위치 질의(ESC[6n)의 응답(CPR)이 입력으로 지나갔는지
    cpr_answered: bool,
    /// 셸과 그 자손이 속한 Job Object — 만들지 못하면 None(트리 종료만으로 정리)
    #[cfg(windows)]
    job: Option<job::Job>,
}

#[cfg(windows)]
use super::job;

impl PtySession {
    fn write_input(&mut self, data: &[u8]) -> std::io::Result<()> {
        if !self.cpr_answered && contains_cpr(data) {
            self.cpr_answered = true;
        }
        self.writer.write_all(data)?;
        self.writer.flush()
    }

    /// 셸과 그 자손 프로세스를 끝낸다.
    fn terminate(&mut self) {
        // 셸에서 띄운 자손(dev 서버 등)이 cwd 를 잡고 있으면 worktree 삭제가 실패한다. 기본 conhost 는 ConPTY 를
        // 닫아도 자손에게 종료 이벤트만 보내 곧바로 끝나지 않으므로(종료 처리를 하는 프로세스는 더 오래 남는다)
        // 닫기 전에 프로세스 트리를 직접 끝낸다(스크립트 취소와 같은 방식). 트리 종료를 먼저 해야 셸이 살아 있어
        // Job 에 들어가기 전(spawn 직후 짧은 틈)에 생긴 자손까지 찾을 수 있고, 이어서 Job 으로 부모 체인이 끊긴
        // 자손(에이전트가 띄운 프로세스 등)을 끝낸다.
        #[cfg(windows)]
        {
            if let Some(pid) = self.child.process_id() {
                super::taskkill_tree(pid);
            }
            if let Some(job) = &self.job {
                job.terminate();
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        // ConPTY 는 시작 시 ESC[6n 을 보내고 응답이 올 때까지 닫기 요청도 처리하지 않는다. 응답 전(xterm 이 붙기 전
        // 언마운트 등)에 닫으면 ClosePseudoConsole 이 영원히 반환하지 않으므로 응답을 대신 보낸다.
        // 이미 응답한 세션에 보내면 살아 남은 자손 프로세스(TUI 등)에 F3 키로 전달되므로 미응답일 때만 보낸다.
        if cfg!(windows) && !self.cpr_answered {
            let _ = self.write_input(b"\x1b[1;1R");
        }
    }

    /// 입력 파이프와 ConPTY/pty 를 닫는다. master 를 drop 하면 리더 스레드도 끝난다
    fn close(self) {
        drop(self.writer);
        drop(self.master);
    }
}

/// 입력에 커서 위치 보고(CPR, `ESC[<행>;<열>R`)가 있는지 — xterm.js 가 ESC[6n 에 자동 응답한 것
fn contains_cpr(data: &[u8]) -> bool {
    (0..data.len()).any(|i| {
        let Some(rest) = data[i..].strip_prefix(b"\x1b[") else {
            return false;
        };
        let row = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        if row == 0 || rest.get(row) != Some(&b';') {
            return false;
        }
        let rest = &rest[row + 1..];
        let col = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        col > 0 && rest.get(col) == Some(&b'R')
    })
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

/// 원격 셸에서 실행할 한 줄. tmux 서버는 처음 실행한 cwd 를 가진 채 남으므로(그 worktree 를 지울 때 걸린다)
/// 홈에서 시작하고 세션의 시작 폴더만 worktree 로 준다 — 원격 CLI(packages/cli/src/host/tmux.ts)와 같은 규칙
pub(crate) fn remote_shell_command(r: &RemotePty, path: &str) -> Result<String, String> {
    if !path.starts_with('/') {
        return Err(format!("원격 경로는 절대 경로여야 합니다: {path}"));
    }
    let dir = ssh::quote(path);
    match &r.session {
        None => Ok(format!("cd -- {dir} && exec \"${{SHELL:-sh}}\" -l")),
        Some(name) => {
            if name.is_empty()
                || !name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err(format!("tmux 세션 이름이 올바르지 않습니다: {name}"));
            }
            let tag = ssh::quote(path.trim_end_matches('/'));
            // -u: 원격 로케일이 UTF-8 이 아니어도 UTF-8 로 그린다(xterm 은 항상 UTF-8) — 없으면 한글이 '_' 로 나온다
            let ephemeral = if r.ephemeral {
                " \\; set-option destroy-unattached on"
            } else {
                ""
            };
            Ok(format!(
                "cd && exec tmux -u -L minmo new-session -A -s {name} -c {dir} \\; set-option @minmo_worktree {tag}{ephemeral}"
            ))
        }
    }
}

/// ssh -t 로 원격 셸을 연다. 프롬프트(비밀번호 등)는 터미널에서 직접 답할 수 있다
fn remote_shell(r: &RemotePty, path: &str) -> Result<CommandBuilder, String> {
    ssh::validate_host(&r.host)?;
    let mut cmd = CommandBuilder::new(ssh::ssh_program());
    cmd.args(ssh::ssh_args(&r.host, false));
    cmd.arg(ssh::sh_wrap(&remote_shell_command(r, path)?));
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        cmd.cwd(home);
    }
    Ok(cmd)
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
    remote: Option<RemotePty>,
) -> Result<String, String> {
    let cmd = match &remote {
        Some(r) => remote_shell(r, &cwd)?,
        None => {
            let mut cmd = CommandBuilder::new(default_shell());
            cmd.cwd(&cwd);
            cmd
        }
    };
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(err)?;
    let mut cmd = cmd;
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave);
    #[cfg(windows)]
    let job = child.process_id().and_then(job::Job::for_process);

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
            host: remote.map(|r| r.host),
            cpr_answered: false,
            #[cfg(windows)]
            job,
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
    s.write_input(data.as_bytes()).map_err(err)
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

/// ConPTY 닫기 대기 상한. 정상 닫기는 수십 ms 이고, 이 시간이 지나도 닫히지 않는 세션은 포기한다
const CLOSE_DEADLINE: Duration = Duration::from_secs(3);

/// 모든 셸(과 자손)을 끝낸 뒤 ConPTY 를 닫고, 마감 안에 닫힌 세션 수를 돌려준다(블로킹).
/// 정리 순서를 지키도록 닫힐 때까지 기다리되, 한 세션의 닫기가 멈춰도 다른 세션과 호출자(worktree 삭제)가
/// 막히지 않도록 세션마다 스레드를 두고 공통 마감까지만 기다린다.
fn kill_and_close(mut sessions: Vec<PtySession>) -> usize {
    for s in &mut sessions {
        s.terminate();
    }
    let total = sessions.len();
    let (tx, rx) = mpsc::channel();
    for s in sessions {
        let tx = tx.clone();
        std::thread::spawn(move || {
            s.close();
            let _ = tx.send(());
        });
    }
    let deadline = Instant::now() + CLOSE_DEADLINE;
    (0..total)
        .take_while(|_| {
            rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .is_ok()
        })
        .count()
}

/// 종료는 프로세스·ConPTY 대기로 블로킹되므로 메인(UI) 스레드가 아닌 블로킹 풀에서 실행한다
async fn kill_sessions(sessions: Vec<PtySession>) -> Result<(), String> {
    if sessions.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || kill_and_close(sessions))
        .await
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let removed = state.sessions.lock().map_err(err)?.remove(&id);
    kill_sessions(removed.into_iter().collect()).await
}

/// 모든 PTY 를 백그라운드에서 끝낸다 — 웹뷰가 새로 고쳐지면(React 정리가 돌지 않음) 남은 셸·에이전트를 정리한다
pub fn kill_all(state: &PtyState) {
    let sessions: Vec<PtySession> = match state.sessions.lock() {
        Ok(mut s) => s.drain().map(|(_, v)| v).collect(),
        Err(_) => return,
    };
    if !sessions.is_empty() {
        std::thread::spawn(move || kill_and_close(sessions));
    }
}

/// 같은 호스트(None = 이 PC)의 세션이고 cwd 가 path 와 같거나 그 하위인가
fn in_target(s: &PtySession, path: &str, host: Option<&str>) -> bool {
    if s.host.as_deref() != host {
        return false;
    }
    match host {
        Some(_) => super::posix_same_or_inside(&s.cwd, path),
        None => super::is_same_or_inside(&s.cwd, path),
    }
}

/// cwd 가 path(또는 하위)인 PTY 를 모두 종료하고 종료 개수를 돌려준다 (worktree 삭제 전 — Windows 파일 잠금 방지)
#[tauri::command]
pub async fn pty_kill_by_cwd(
    state: State<'_, PtyState>,
    path: String,
    host: Option<String>,
) -> Result<u32, String> {
    let targets: Vec<PtySession> = {
        let mut sessions = state.sessions.lock().map_err(err)?;
        let ids: Vec<String> = sessions
            .iter()
            .filter(|(_, s)| in_target(s, &path, host.as_deref()))
            .map(|(id, _)| id.clone())
            .collect();
        ids.iter().filter_map(|id| sessions.remove(id)).collect()
    };
    let n = targets.len() as u32;
    kill_sessions(targets).await?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(session: Option<&str>, ephemeral: bool) -> RemotePty {
        RemotePty {
            host: "h".into(),
            session: session.map(str::to_string),
            ephemeral,
        }
    }

    #[test]
    fn remote_shell_command_attaches_tmux_or_opens_a_login_shell() {
        assert_eq!(
            remote_shell_command(&remote(None, false), "/w/it's").unwrap(),
            "cd -- '/w/it'\\''s' && exec \"${SHELL:-sh}\" -l"
        );
        assert_eq!(
            remote_shell_command(&remote(Some("minmo-0a1b2c3d4e"), false), "/w/t/").unwrap(),
            "cd && exec tmux -u -L minmo new-session -A -s minmo-0a1b2c3d4e -c '/w/t/' \\; set-option @minmo_worktree '/w/t'"
        );
        assert!(
            remote_shell_command(&remote(Some("minmo-0a1b2c3d4e-p2"), true), "/w/t")
                .unwrap()
                .ends_with("\\; set-option destroy-unattached on")
        );
    }

    #[test]
    fn remote_shell_command_rejects_bad_session_names_and_relative_paths() {
        assert!(remote_shell_command(&remote(Some("a;b"), false), "/w").is_err());
        assert!(remote_shell_command(&remote(Some(""), false), "/w").is_err());
        assert!(remote_shell_command(&remote(None, false), "w/t").is_err());
    }

    #[test]
    fn contains_cpr_detects_only_cursor_reports() {
        assert!(contains_cpr(b"\x1b[1;1R"));
        assert!(contains_cpr(b"ab\x1b[24;80Rcd"));
        assert!(!contains_cpr(b"\x1b[6n"));
        assert!(!contains_cpr(b"\x1b[A"));
        assert!(!contains_cpr(b"\x1b[;1R"));
        assert!(!contains_cpr(b"\x1b[1;R"));
        assert!(!contains_cpr(b"echo 1;2R\r"));
    }

    #[cfg(windows)]
    mod conpty {
        use super::super::*;
        use std::mem::ManuallyDrop;
        use std::path::Path;
        use std::sync::Arc;

        /// 쓴 바이트를 기록하면서 실제 입력 파이프로 넘긴다
        struct Tee {
            inner: Box<dyn Write + Send>,
            log: Arc<Mutex<Vec<u8>>>,
        }

        impl Write for Tee {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                let n = self.inner.write(buf)?;
                self.log.lock().unwrap().extend_from_slice(&buf[..n]);
                Ok(n)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                self.inner.flush()
            }
        }

        struct Pty {
            // 실패로 unwinding 중 drop 되면 바로 그 ClosePseudoConsole 대기로 테스트가 멈출 수 있어 직접 drop 하지 않는다
            session: ManuallyDrop<PtySession>,
            output: mpsc::Receiver<Vec<u8>>,
            input_log: Arc<Mutex<Vec<u8>>>,
        }

        /// cmd.exe PTY 를 띄우고, 앱의 리더 스레드처럼 출력을 계속 비우면서 누적 출력을 채널로 보낸다
        fn spawn_cmd_pty(cwd: Option<&Path>) -> Pty {
            let pair = native_pty_system()
                .openpty(PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .unwrap();
            let mut cmd = CommandBuilder::new("cmd.exe");
            if let Some(dir) = cwd {
                cmd.cwd(dir);
            }
            let child = pair.slave.spawn_command(cmd).unwrap();
            drop(pair.slave);
            let job = child.process_id().and_then(job::Job::for_process);
            assert!(job.is_some(), "셸을 Job Object 에 넣지 못했다");
            let input_log = Arc::new(Mutex::new(Vec::new()));
            let writer = Box::new(Tee {
                inner: pair.master.take_writer().unwrap(),
                log: input_log.clone(),
            });
            let mut reader = pair.master.try_clone_reader().unwrap();
            let (tx, output) = mpsc::channel();
            std::thread::spawn(move || {
                let mut buf = [0u8; 1024];
                let mut out = Vec::new();
                while let Ok(n @ 1..) = reader.read(&mut buf) {
                    out.extend_from_slice(&buf[..n]);
                    let _ = tx.send(out.clone());
                }
            });
            let session = PtySession {
                master: pair.master,
                writer,
                child,
                cwd: String::new(),
                host: None,
                cpr_answered: false,
                job,
            };
            Pty {
                session: ManuallyDrop::new(session),
                output,
                input_log,
            }
        }

        fn count(hay: &[u8], pat: &[u8]) -> usize {
            hay.windows(pat.len()).filter(|w| *w == pat).count()
        }

        fn wait_output(rx: &mpsc::Receiver<Vec<u8>>, pat: &[u8], what: &str) {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(out) if count(&out, pat) > 0 => return,
                    Ok(_) => continue,
                    Err(_) => panic!("{what} 을(를) 10초 안에 받지 못했다"),
                }
            }
        }

        /// xterm 처럼 커서 질의에 응답하고 셸이 명령을 처리하는지 확인한다
        fn answer_cursor_query_and_wait_shell(pty: &mut Pty) {
            wait_output(&pty.output, b"\x1b[6n", "커서 위치 질의(ESC[6n)");
            pty.session.write_input(b"\x1b[1;1R").unwrap();
            // 입력 에코(minmo-%OS%)와 구분되도록 셸이 확장한 값을 기다린다
            pty.session.write_input(b"echo minmo-%OS%\r").unwrap();
            wait_output(&pty.output, b"minmo-Windows_NT", "셸 응답");
        }

        /// kill_and_close 를 별도 스레드에서 실행해 멈춰도 테스트가 무한 대기하지 않게 한다.
        /// 마감 안에 닫힌 세션 수와 입력 기록을 돌려준다
        fn kill_with_timeout(pty: Pty) -> (usize, Vec<u8>) {
            let session = ManuallyDrop::into_inner(pty.session);
            let (done_tx, done_rx) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = done_tx.send(kill_and_close(vec![session]));
            });
            let closed = done_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("kill_and_close 가 10초 안에 반환하지 않았다");
            let log = pty.input_log.lock().unwrap().clone();
            (closed, log)
        }

        /// 실제 앱: spawn 응답 전에 터미널이 언마운트되면 xterm 이 커서 질의에 응답할 기회 없이 ptyKill 이 호출된다
        #[test]
        fn kill_before_cursor_query_answered_closes_conpty() {
            let pty = spawn_cmd_pty(None);
            wait_output(&pty.output, b"\x1b[6n", "커서 위치 질의(ESC[6n)");
            let (closed, input) = kill_with_timeout(pty);
            assert_eq!(
                closed, 1,
                "ConPTY 가 마감 안에 닫히지 않았다(ClosePseudoConsole 대기)"
            );
            assert_eq!(
                count(&input, b"\x1b[1;1R"),
                1,
                "미응답 세션에는 응답을 대신 1회 보낸다"
            );
        }

        /// 정상 흐름: xterm 이 응답해 셸이 떠 있는 상태에서 종료
        #[test]
        fn kill_running_shell_after_cursor_query_answered() {
            let mut pty = spawn_cmd_pty(None);
            answer_cursor_query_and_wait_shell(&mut pty);
            let (closed, input) = kill_with_timeout(pty);
            assert_eq!(closed, 1, "ConPTY 가 마감 안에 닫히지 않았다");
            assert_eq!(
                count(&input, b"\x1b[1;1R"),
                1,
                "이미 응답한 세션에 다시 보내면 살아 남은 자손 프로세스에 F3 로 전달된다"
            );
        }

        /// worktree 삭제 시나리오: 셸에서 띄운 자손 프로세스가 cwd 를 잡고 있어도 종료 직후 디렉터리를 지울 수 있어야 한다
        #[test]
        fn kill_releases_cwd_held_by_grandchild() {
            let dir = std::env::temp_dir().join(format!("minmo-pty-test-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let mut pty = spawn_cmd_pty(Some(&dir));
            answer_cursor_query_and_wait_shell(&mut pty);
            pty.session
                .write_input(b"powershell -NoProfile -Command \"Write-Output ('gc-' + 'ready'); Start-Sleep 60\"\r")
                .unwrap();
            wait_output(&pty.output, b"gc-ready", "손자 프로세스 시작");
            let (closed, _) = kill_with_timeout(pty);
            // TerminateProcess 는 종료를 시작만 하므로 핸들 해제를 아주 짧게(최대 3ms) 기다린다.
            // 트리 종료가 없으면 기본 conhost 에서 손자가 닫기 뒤 약 7ms 더 남아(측정값) 여기서 실패한다
            let mut removed = std::fs::remove_dir_all(&dir);
            for _ in 0..3 {
                if removed.is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(1));
                removed = std::fs::remove_dir_all(&dir);
            }
            assert!(removed.is_ok(), "종료 후에도 cwd 가 잠겨 있다: {removed:?}");
            assert_eq!(closed, 1, "ConPTY 가 마감 안에 닫히지 않았다");
        }

        fn pid_alive(pid: u32) -> bool {
            let out = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
        }

        /// 패널 닫기(Ctrl+W) 시나리오: 에이전트처럼 중간 부모가 먼저 끝나 부모 체인이 끊긴 자손도 함께 끝나야 한다.
        /// taskkill /T 는 이런 고아를 찾지 못하므로 Job Object 가 없으면 실패한다
        #[test]
        fn kill_terminates_orphaned_descendant() {
            let mut pty = spawn_cmd_pty(None);
            answer_cursor_query_and_wait_shell(&mut pty);
            // 바깥 powershell 은 손자를 띄우고 pid 를 출력한 뒤 바로 끝난다 → 손자는 부모 없는 고아가 된다
            pty.session
                .write_input(
                    concat!(
                        "powershell -NoProfile -Command \"$p = Start-Process powershell ",
                        "-ArgumentList '-NoProfile','-Command','Start-Sleep 60' -WindowStyle Hidden -PassThru; ",
                        "Write-Output ('orphan=' + $p.Id + '=end')\"\r"
                    )
                    .as_bytes(),
                )
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            let pid = loop {
                let out = pty
                    .output
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .expect("고아 프로세스 pid 를 받지 못했다");
                let text = String::from_utf8_lossy(&out);
                // 명령 에코('orphan=' + ...)와 구분되도록 실제 숫자가 찍힌 줄만 받는다
                if let Some(pid) = text
                    .split("orphan=")
                    .skip(1)
                    .filter_map(|s| s.split("=end").next()?.trim().parse::<u32>().ok())
                    .next()
                {
                    break pid;
                }
            };
            assert!(pid_alive(pid), "고아 프로세스가 시작되지 않았다");
            let (closed, _) = kill_with_timeout(pty);
            // TerminateJobObject 도 종료를 시작만 하므로 잠시 기다린다
            let gone = (0..50).any(|_| {
                let alive = pid_alive(pid);
                if alive {
                    std::thread::sleep(Duration::from_millis(20));
                }
                !alive
            });
            if !gone {
                // 실패해도 테스트 프로세스가 남지 않게 정리한다
                super::super::super::taskkill_tree(pid);
            }
            assert!(gone, "PTY 종료 후에도 고아 자손(pid {pid})이 살아 있다");
            assert_eq!(closed, 1, "ConPTY 가 마감 안에 닫히지 않았다");
        }
    }
}
