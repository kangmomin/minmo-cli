// 터미널 PTY (F-04, AC-08). 세션별 cwd 를 기록해 worktree 삭제 전 pty_kill_by_cwd 로 선종료한다.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use super::pty_link::{
    self, Ev, Link, MarkerFilter, Phase, Signal, Timing, ALT_SCREEN_MODES, MAX_ATTEMPTS, TAIL_LIMIT,
};
use super::ssh;

/// 원격 터미널 요청. session 이 있으면 전용 tmux(-L minmo) 세션에 붙고, 없으면 로그인 셸을 연다
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePty {
    pub(crate) host: String,
    pub(crate) session: Option<String>,
    /// 분할로 만든 추가 패널(-pN 세션) — 끊겨도 남아 다시 붙고, 패널을 닫을 때 화면이 끝낸다
    #[serde(default)]
    pub(crate) ephemeral: bool,
}

pub struct PtySession {
    pub(crate) proc: Proc,
    pub(crate) cwd: String,
    /// 화면의 패널 id — 같은 패널을 여는 다른 기기(원격 접속)가 이 터미널에 함께 붙는다
    key: Option<String>,
    /// 최근 출력 — 나중에 붙은 화면이 지금까지의 내용을 그릴 수 있게 보관한다
    pub(crate) scrollback: Arc<Mutex<Scrollback>>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    /// 원격 세션을 연 요청 — 재접속은 처음 연 값으로 다시 연다(EC-06)
    pub(crate) remote: Option<RemotePty>,
    /// 지금 세대(link.gen 의 거울) — 리더가 세션 잠금 없이 자기 세대인지 본다. link.gen 과 함께만 바꾼다
    pub(crate) gen: Arc<AtomicU64>,
    /// 연결 상태(원격). 로컬은 늘 연결됨
    pub(crate) link: Link,
    /// 재접속 감독에게 보내는 통로(감독이 있는 원격 세션만). 감독·리더는 복사해 두지 않는다 —
    /// 세션을 빼는 쪽이 이것을 먼저 버려 감독이 끝을 알게 한다
    pub(crate) tx: Option<mpsc::Sender<Ev>>,
}

impl PtySession {
    /// 원격(ssh) 세션이면 호스트 별칭 — 이때 cwd 는 원격 경로다
    fn host(&self) -> Option<&str> {
        self.remote.as_ref().map(|r| r.host.as_str())
    }

    /// 지금 세대를 올린다(link.gen 과 거울을 함께)
    pub(crate) fn advance_gen(&mut self) -> u64 {
        self.link.advance_gen();
        self.sync_gen()
    }

    /// 기다리던 시도를 시작한다 — 새 세대로(link.gen 과 거울을 함께)
    fn begin_attempt(&mut self) {
        pty_link::begin_attempt(&mut self.link);
        self.sync_gen();
    }

    /// 거울을 link.gen 에 맞춘다 — 세대를 바꾸는 곳은 이것으로만 거울을 쓴다
    fn sync_gen(&self) -> u64 {
        self.gen.store(self.link.gen, Ordering::SeqCst);
        self.link.gen
    }
}

/// 한 세대(ssh 하나)의 리더와 감독이 함께 보는 값 — 리더가 출력 조각마다 세션을 잠그지 않게 따로 둔다
#[derive(Default)]
pub(crate) struct GenShared {
    /// 재접속 시도 중(Connecting) — 리더가 창 제목을 뺀다(ConPTY 가 내는 ssh.exe 경로 제목에 에이전트 제목을 잃지 않게)
    connecting: AtomicBool,
    /// 연결 신호 전 — 리더가 출력을 꼬리에 모으고 신호를 감독 상태에 알린다
    collecting: AtomicBool,
    /// 연결 신호 전까지의 출력 끝부분(gen_tail) — 끝났을 때 인증·호스트 키 실패를 가린다
    tail: Mutex<String>,
}

impl GenShared {
    pub(crate) fn set_connecting(&self, on: bool) {
        self.connecting.store(on, Ordering::SeqCst);
    }

    fn set_collecting(&self, on: bool) {
        self.collecting.store(on, Ordering::SeqCst);
    }

    pub(crate) fn tail(&self) -> String {
        self.tail.lock().map(|t| t.clone()).unwrap_or_default()
    }

    fn push_tail(&self, text: &str) {
        if let Ok(mut tail) = self.tail.lock() {
            tail.push_str(text);
            // visible() 이 끝 TAIL_LIMIT 를 자르며 잘린 앞 조각을 버린다 — 그보다 넉넉히 남겨 이 자름이 보이지 않게
            if tail.len() > 2 * TAIL_LIMIT {
                let cut = pty_link::char_boundary_from(&tail, tail.len() - TAIL_LIMIT * 3 / 2);
                tail.drain(..cut);
            }
        }
    }
}

/// 셸(원격이면 ssh) 프로세스 하나와 그 PTY — 원격 터미널이 다시 접속하면 이것만 통째로 바뀐다
pub(crate) struct Proc {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// ConPTY 시작 커서 위치 질의(ESC[6n)의 응답(CPR)이 입력으로 지나갔는지
    cpr_answered: bool,
    /// 시작 질의에 줄 답 — 첫 세대는 1행 1열, 재접속 세대는 준비 시퀀스가 커서를 둔 맨 아래 행
    cpr_reply: Vec<u8>,
    /// 이 세대의 리더와 함께 보는 값
    pub(crate) shared: Arc<GenShared>,
    /// 셸과 그 자손이 속한 Job Object — 만들지 못하면 None(트리 종료만으로 정리). 세션 잠금 밖에서도 끝낼 수 있게 Arc
    #[cfg(windows)]
    job: Option<Arc<job::Job>>,
}

#[cfg(windows)]
use super::job;

/// 세션 잠금 밖에서 한 세대의 ssh 와 그 자손(ProxyCommand·ProxyJump 등)을 끝낸다
pub(crate) struct Stopper {
    killer: Box<dyn ChildKiller + Send + Sync>,
    #[cfg(windows)]
    job: Option<Arc<job::Job>>,
}

impl Stopper {
    pub(crate) fn stop(mut self) {
        let _ = self.killer.kill();
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
    }
}

impl Proc {
    fn write_input(&mut self, data: &[u8]) -> std::io::Result<()> {
        if !self.cpr_answered && contains_cpr(data) {
            self.cpr_answered = true;
        }
        self.writer.write_all(data)?;
        self.writer.flush()
    }

    /// ConPTY 의 시작 질의(ESC[6n)에 아직 답하지 않았으면 답한다. 질의는 PTY 의 맨 처음에 오고 그 앞의 출력은 모드 설정뿐이라
    /// 커서는 첫 세대면 1행 1열, 재접속 세대면 준비 시퀀스가 둔 맨 아래 행이다(cpr_reply). 이미 답한 세션에 또 보내면
    /// 살아 있는 프로그램에 F3 키로 들어가므로 한 번만 보낸다
    fn answer_startup_query(&mut self) {
        if !self.cpr_answered {
            self.cpr_answered = true;
            let _ = self
                .writer
                .write_all(&self.cpr_reply)
                .and_then(|()| self.writer.flush());
        }
    }

    /// 프로세스가 끝났으면 종료 코드(Some), 아직 돌면 None
    pub(crate) fn exit_code(&mut self) -> std::io::Result<Option<u32>> {
        Ok(self.child.try_wait()?.map(|s| s.exit_code()))
    }

    pub(crate) fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub(crate) fn stopper(&self) -> Stopper {
        Stopper {
            killer: self.child.clone_killer(),
            #[cfg(windows)]
            job: self.job.clone(),
        }
    }

    fn set_size(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(err)
    }

    #[cfg(test)]
    pub(crate) fn pid(&self) -> Option<u32> {
        self.child.process_id()
    }

    /// PTY 크기(cols, rows)
    #[cfg(test)]
    pub(crate) fn size(&self) -> Option<(u16, u16)> {
        self.master.get_size().ok().map(|s| (s.cols, s.rows))
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
            // 이미 끝난 셸은 pid 로 트리를 찾을 수 없어 taskkill 을 띄우지 않는다(끊긴 ssh 를 정리할 때마다 생긴다).
            // 남은 자손은 Job 이 끝낸다 — Job 은 핸들이라 셸이 먼저 끝나도 항상 끝낸다(EC-09)
            let exited = matches!(self.child.try_wait(), Ok(Some(_)));
            if let (false, Some(pid)) = (exited, self.child.process_id()) {
                super::taskkill_tree(pid);
            }
            if let Some(job) = &self.job {
                job.terminate();
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        // ConPTY 는 시작 시 ESC[6n 을 보내고 응답이 올 때까지 닫기 요청도 처리하지 않는다. 리더 스레드가 질의를 읽기 전에
        // 닫으면 ClosePseudoConsole 이 영원히 반환하지 않으므로 응답을 대신 보낸다(미응답일 때만).
        if cfg!(windows) {
            self.answer_startup_query();
        }
    }

    /// 입력 파이프와 ConPTY/pty 를 닫는다. master 를 drop 하면 리더 스레드도 끝난다
    fn close(self) {
        drop(self.writer);
        drop(self.master);
    }
}

/// 보관하는 최근 출력의 상한(바이트)
const SCROLLBACK_LIMIT: usize = 256 * 1024;

/// 조각 끝에서 잘린 모드 시퀀스(`ESC[?…`)로 보고 다음 조각까지 넘기는 길이의 상한
const MODE_CARRY_LIMIT: usize = 32;

#[derive(Default)]
pub(crate) struct Scrollback {
    /// 보관한 최근 출력
    text: String,
    /// 지금까지 나온 전체 길이 — 붙는 화면이 "어디까지 받았는지" 맞추는 데 쓴다
    total: u64,
    /// 앞을 버린 적이 있는가 — 그 뒤로는 text 만 다시 그려서는 화면을 되살릴 수 없다
    truncated: bool,
    /// 출력 전체에서 본 DEC private mode 의 지금 상태(번호 → 켜짐). 앞을 버려도 남는다
    modes: std::collections::BTreeMap<u16, bool>,
    /// 조각 끝에서 잘린 모드 시퀀스 — 다음 조각 앞에 붙여 읽는다
    carry: String,
}

impl Scrollback {
    fn push(&mut self, text: &str) -> u64 {
        self.track_modes(text);
        self.total += text.len() as u64;
        self.text.push_str(text);
        if self.text.len() > SCROLLBACK_LIMIT {
            // 넘친 만큼 앞을 버리되 줄 경계에서 자른다 — 제어 문자열 중간부터 다시 그리면 화면이 깨진다
            let cut = pty_link::char_boundary_from(&self.text, self.text.len() - SCROLLBACK_LIMIT);
            let cut = self.text[cut..].find('\n').map_or(cut, |i| cut + i + 1);
            self.text.drain(..cut);
            self.truncated = true;
        }
        self.total
    }

    /// `ESC[?<번호>[;<번호>…]h|l` 을 읽어 모드의 지금 상태를 기록한다
    fn track_modes(&mut self, text: &str) {
        let joined;
        let text = if self.carry.is_empty() {
            text
        } else {
            joined = std::mem::take(&mut self.carry) + text;
            &joined
        };
        let mut rest = text;
        while let Some(at) = rest.find('\x1b') {
            let seq = &rest[at..];
            let Some(params) = seq.strip_prefix("\x1b[?") else {
                // 조각이 `ESC` 나 `ESC[` 에서 끝났으면 뒤가 다음 조각에 온다
                if seq == "\x1b" || seq == "\x1b[" {
                    self.carry = seq.to_string();
                    return;
                }
                rest = &seq[1..];
                continue;
            };
            let len = params
                .bytes()
                .take_while(|b| b.is_ascii_digit() || *b == b';')
                .count();
            match params.as_bytes().get(len) {
                Some(end @ (b'h' | b'l')) => {
                    for mode in params[..len].split(';').filter_map(|m| m.parse().ok()) {
                        self.modes.insert(mode, *end == b'h');
                    }
                }
                // 끝 글자가 아직 오지 않았다 — 너무 길면 모드 시퀀스가 아니므로 버린다
                None if seq.len() <= MODE_CARRY_LIMIT => {
                    self.carry = seq.to_string();
                    return;
                }
                _ => {}
            }
            rest = &params[len..];
        }
    }

    fn alt_screen(&self) -> bool {
        pty_link::alt_screen_on(&self.modes)
    }

    /// 새 세대의 출력 앞에 넣을 준비 시퀀스. 옛 세대가 조각 끝에 남긴 잘린 모드 시퀀스는 버린다(새 출력과 이어 읽지 않게)
    fn reattach(&mut self, rows: u16, clear_title: bool) -> String {
        self.carry.clear();
        pty_link::reattach_prelude(&self.modes, rows, clear_title)
    }

    /// 나중에 붙는 화면이 먼저 그릴 글과, 프로그램에 화면 전체를 다시 그리게 해야 하는지를 돌려준다.
    /// 앞을 버린 적이 없으면 보관한 출력이 전부이므로 그대로 다시 그리면 정확하다. 버린 뒤에는 모드(대체 화면·마우스 등)를
    /// 켠 시퀀스가 사라졌을 수 있어 지금 상태를 앞에 붙인다. 대체 화면의 프로그램은 바뀐 칸만 보내므로, 남은 꼬리는
    /// 사라진 화면에 대한 변경분이다 — 그리면 잔상이 남는다. 그래서 꼬리는 버리고 빈 대체 화면에서 다시 그리게 한다.
    fn restore(&self) -> (String, bool) {
        if !self.truncated {
            return (self.text.clone(), false);
        }
        let alt = self.alt_screen();
        let mut out = String::new();
        if alt {
            out.push_str("\x1b[?1049h\x1b[2J\x1b[H");
        }
        for (mode, on) in &self.modes {
            if !ALT_SCREEN_MODES.contains(mode) {
                out.push_str(&format!("\x1b[?{mode}{}", if *on { 'h' } else { 'l' }));
            }
        }
        if !alt {
            out.push_str(&self.text);
        }
        (out, alt)
    }
}

/// 커서 위치 질의(DSR 6)
const CURSOR_QUERY: &str = "\x1b[6n";
/// 커서 위치 보고 — 1행 1열
const CURSOR_HOME_REPORT: &[u8] = b"\x1b[1;1R";

/// ConPTY 의 시작 질의를 출력에서 찾아 뺀다. ConPTY(INHERIT_CURSOR)는 시작하자마자 ESC[6n 을 보내고, 응답이 올 때까지
/// 출력·입력을 모두 멈춘다. 화면(xterm)이 답하게 두면, 화면이 입력을 연결하기 전에 질의를 처리하거나 다시 붙은 화면이
/// 지난 출력을 재생하며 답을 막을 때 터미널이 빈 화면으로 멈춘다(#56). 그래서 PTY 를 가진 쪽이 답하고 화면에는 보내지 않는다
/// — 화면도 답하면 두 번째 응답이 프로그램에 F3 키로 들어간다.
struct StartupQuery {
    /// 아직 질의를 기다리는가. Unix pty 에는 이 질의가 없다 — 프로그램의 질의를 가로채지 않게 Windows 에서만 기다린다
    waiting: bool,
    /// 조각 끝에서 잘린 시퀀스 — 다음 조각 앞에 붙여 읽는다
    carry: String,
}

/// 조각 앞의 CSI(`ESC [ 매개변수 중간 끝`)
enum Csi {
    Complete(usize),
    /// 조각 끝에서 끊겼다
    Partial,
}

/// rest 가 CSI 로 시작하면 그 길이(끊겼으면 Partial). CSI 가 아니면 None
fn leading_csi(rest: &str) -> Option<Csi> {
    let b = rest.as_bytes();
    match b {
        [0x1b] => return Some(Csi::Partial),
        [0x1b, b'[', ..] => {}
        _ => return None,
    }
    let end = 2 + b[2..]
        .iter()
        .take_while(|c| (0x20..=0x3f).contains(*c))
        .count();
    match b.get(end) {
        Some(0x40..=0x7e) => Some(Csi::Complete(end + 1)),
        None if b.len() <= MODE_CARRY_LIMIT => Some(Csi::Partial),
        _ => None,
    }
}

impl StartupQuery {
    fn new() -> Self {
        Self::waiting(cfg!(windows))
    }

    fn waiting(waiting: bool) -> Self {
        Self {
            waiting,
            carry: String::new(),
        }
    }

    /// 출력 조각에서 시작 질의를 뺀 나머지와, 이 조각에서 질의를 찾았는지를 돌려준다.
    /// 질의 앞에는 ConPTY 의 모드 설정(CSI)만 온다 — 다른 출력이 먼저 나오면 질의가 없는 것으로 보고 그만 찾는다
    fn filter(&mut self, text: String) -> (String, bool) {
        if !self.waiting {
            return (text, false);
        }
        let text = std::mem::take(&mut self.carry) + &text;
        let mut at = 0;
        while at < text.len() {
            let rest = &text[at..];
            if let Some(after) = rest.strip_prefix(CURSOR_QUERY) {
                self.waiting = false;
                return (format!("{}{after}", &text[..at]), true);
            }
            match leading_csi(rest) {
                Some(Csi::Complete(len)) => at += len,
                Some(Csi::Partial) => {
                    self.carry = rest.to_string();
                    return (text[..at].to_string(), false);
                }
                None => {
                    self.waiting = false;
                    return (text, false);
                }
            }
        }
        (text, false)
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

/// PTY 가 화면에 알리는 통로 — 앱에서는 이벤트(AppSink), 테스트에서는 기록용
pub(crate) trait Sink: Send + Sync {
    fn data(&self, id: &str, data: String, end: u64);
    fn exit(&self, id: &str);
    fn resized(&self, id: &str, cols: u16, rows: u16, by: Option<String>);
    /// 원격 터미널의 연결 상태가 바뀌었다(pty-link)
    fn link(&self, ev: PtyLinkEvent);
}

struct AppSink(AppHandle);

impl Sink for AppSink {
    fn data(&self, id: &str, data: String, end: u64) {
        let id = id.to_string();
        let _ = self.0.emit("pty-data", PtyData { id, data, end });
    }

    fn exit(&self, id: &str) {
        let _ = self.0.emit("pty-exit", id.to_string());
    }

    fn resized(&self, id: &str, cols: u16, rows: u16, by: Option<String>) {
        let id = id.to_string();
        let _ = self
            .0
            .emit("pty-resized", PtyResized { id, cols, rows, by });
    }

    fn link(&self, ev: PtyLinkEvent) {
        let _ = self.0.emit("pty-link", ev);
    }
}

/// 원격 세션의 재접속 감독(스레드 본문) — setup 에서 pty_reconnect 가 넣는다(pty 는 pty_reconnect 를 직접 부르지 않는다)
pub(crate) type SupervisorFn = fn(Arc<Hub>, String, mpsc::Receiver<Ev>);

/// 원격 세션의 ssh 를 PTY 로 연다(요청, 원격 cwd, cols, rows) — 재접속도 시도마다 이것으로 연다. 테스트는 다른 명령을 넣는다
pub(crate) type Spawner =
    Box<dyn Fn(&RemotePty, &str, u16, u16) -> Result<Opened, String> + Send + Sync>;

/// 터미널 세션과 알림 통로. 리더 스레드는 AppHandle 대신 이것을 받는다 — 테스트가 기록용 Sink 로 그대로 돌릴 수 있게.
/// 잠금 순서: sessions → Scrollback → 세대 꼬리(GenShared.tail). 반대 방향으로 잡지 않는다(Scrollback 을 쥔 채 sessions 를 잡지 않는다)
pub(crate) struct Hub {
    pub(crate) sessions: Mutex<HashMap<String, PtySession>>,
    /// key 로 여는 동안 잡는다 — 두 화면이 같은 패널을 동시에 열어도 셸은 하나만 뜬다
    opening: Mutex<()>,
    seq: AtomicU64,
    /// setup 에서 한 번 넣는다 — PtyState 를 등록하는 순서(on_page_load·remote.rs 가 쓴다)를 바꾸지 않게
    pub(crate) sink: OnceLock<Arc<dyn Sink>>,
    /// 없으면(넣기 전) 원격 세션도 로컬처럼 끝나면 바로 pty-exit 를 낸다
    pub(crate) supervisor: OnceLock<SupervisorFn>,
    pub(crate) spawner: Spawner,
    pub(crate) timing: Timing,
    /// 감독이 깨어난 횟수 — 테스트가 바쁜 대기가 없는지 본다
    #[cfg(test)]
    pub(crate) wakes: AtomicU64,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new(Box::new(open_remote), Timing::default())
    }
}

impl Hub {
    pub(crate) fn new(spawner: Spawner, timing: Timing) -> Self {
        Self {
            sessions: Mutex::default(),
            opening: Mutex::default(),
            seq: AtomicU64::default(),
            sink: OnceLock::new(),
            supervisor: OnceLock::new(),
            spawner,
            timing,
            #[cfg(test)]
            wakes: AtomicU64::default(),
        }
    }

    pub(crate) fn sink(&self) -> Option<&dyn Sink> {
        self.sink.get().map(|s| s.as_ref())
    }
}

#[derive(Default)]
pub struct PtyState {
    hub: Arc<Hub>,
}

impl PtyState {
    /// 이벤트를 낼 앱을 넣는다(setup 에서 한 번)
    pub fn attach(&self, app: &AppHandle) {
        let _ = self.hub.sink.set(Arc::new(AppSink(app.clone())));
    }

    /// 원격 세션의 재접속 감독을 넣는다(setup 에서 한 번)
    pub fn set_supervisor(&self, f: SupervisorFn) {
        let _ = self.hub.supervisor.set(f);
    }

    pub(crate) fn hub(&self) -> &Hub {
        &self.hub
    }
}

#[derive(Clone, Serialize)]
struct PtyData {
    id: String,
    data: String,
    /// 이 조각까지의 전체 출력 길이 — 붙는 화면이 지난 출력(scrollback)과 겹치는 조각을 가려낸다
    end: u64,
}

/// 연결 상태 — pty-link 이벤트와 pty_find 응답에 싣는다
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct LinkView {
    /// "connected" | "waiting" | "connecting" | "failed"
    pub(crate) phase: &'static str,
    pub(crate) attempt: u32,
    pub(crate) max: u32,
    pub(crate) seq: u64,
    /// 실패 원인: "auth" | "host_key" | "spawn"
    pub(crate) reason: Option<&'static str>,
    /// 다시 접속한 시각(HH:MM)
    pub(crate) at: Option<String>,
}

impl From<&Link> for LinkView {
    fn from(l: &Link) -> Self {
        Self {
            phase: match l.phase {
                Phase::Live => "connected",
                Phase::Waiting => "waiting",
                Phase::Connecting => "connecting",
                Phase::Failed => "failed",
            },
            attempt: l.attempt,
            max: MAX_ATTEMPTS,
            seq: l.seq,
            reason: l.reason,
            at: l.at.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct PtyLinkEvent {
    pub(crate) id: String,
    #[serde(flatten)]
    pub(crate) link: LinkView,
}

/// 지금 시각(이 PC 의 현지 시각 HH:MM) — 구분 줄·다시 접속한 시각
pub(crate) fn now_hhmm() -> String {
    chrono::Local::now().format("%H:%M").to_string()
}

fn push_and_emit(hub: &Hub, id: &str, sb: Option<&mut Scrollback>, text: String) {
    let end = sb.map_or(0, |sb| sb.push(&text));
    if let Some(sink) = hub.sink() {
        sink.data(id, text, end);
    }
}

/// 출력 한 조각을 보관(모드 추적)하고 화면에 보낸다. 보관과 알림을 같은 잠금 안에서 해 알림 순서가 end 순서와 같다
fn emit_output(hub: &Hub, id: &str, scrollback: &Mutex<Scrollback>, text: String) {
    let mut sb = scrollback.lock().ok();
    push_and_emit(hub, id, sb.as_deref_mut(), text);
}

/// 연결 상태 알림(pty-link)과 그 뒤에 넣을 출력(준비 시퀀스·구분 줄)을 세션 잠금 안에서 차례로 낸다 —
/// 화면이 상태를 먼저 받아 주입된 출력을 그 상태로 읽는다. 호출자는 sessions 를 잠근 채 부른다
pub(crate) fn announce(hub: &Hub, id: &str, s: &PtySession, inject: Option<String>) {
    if let Some(sink) = hub.sink() {
        sink.link(PtyLinkEvent {
            id: id.to_string(),
            link: LinkView::from(&s.link),
        });
    }
    if let Some(text) = inject {
        emit_output(hub, id, &s.scrollback, text);
    }
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

/// tmux 가 바깥 터미널에 내보낼 제목 형식 — desktop/src/features/agents/detect.ts 의 TMUX_TITLE_PREFIX 와 짝이다
const TMUX_TITLE_FORMAT: &str = "minmo:#{pane_current_command}:#{pane_title}";

/// bash 의 rcfile 로 읽힐 내용(fd 3) — 로그인 셸과 같은 순서로 시작 파일을 읽은 뒤 worktree 로 돌아온다.
/// 시작 파일(~/.bashrc 등)이 cd 를 하면 셸을 띄우기 전에 한 cd 가 덮이기 때문이다
const BASH_LOGIN_RC: &str = r#"exec 3<&-; [ -r /etc/profile ] && . /etc/profile; for f in ~/.bash_profile ~/.bash_login ~/.profile; do if [ -r "$f" ]; then . "$f"; break; fi; done; unset f; cd -- "$MINMO_WORKTREE""#;

/// worktree(dir = 인용된 경로)에서 사용자 셸을 여는 한 줄(POSIX sh). bash 는 시작 파일 뒤에 worktree 로 돌아오고,
/// 그 밖의 셸은 로그인 셸 그대로다(시작 파일이 cd 를 하면 그 폴더에서 시작한다). exec 는 셸 앞에 붙일 말("exec " 또는 "")
fn shell_line(dir: &str, exec: &str) -> String {
    let rc = ssh::quote(BASH_LOGIN_RC);
    format!(
        "cd -- {dir} && export MINMO_WORKTREE={dir} && case \"${{SHELL##*/}}\" in bash) {exec}\"$SHELL\" -c 'exec \"$0\" --rcfile /dev/fd/3 -i 3<<<\"$1\"' \"$SHELL\" {rc} ;; *) {exec}\"${{SHELL:-sh}}\" -l ;; esac"
    )
}

/// tmux 첫 창의 셸 — 셸로 바뀐다(exec)
fn worktree_shell(dir: &str) -> String {
    shell_line(dir, "exec ")
}

/// 로그인 셸(tmux 없음) — 셸이 끝나기를 기다려 종료 코드 255 만 254 로 바꿔 넘긴다. ssh 는 자기가 실패할 때 255 로
/// 끝나므로, 셸의 255 를 그대로 넘기면 끊김으로 읽혀 자동 재접속이 돈다(D-27)
fn login_shell(dir: &str) -> String {
    format!(
        "{}; s=$?; [ $s -eq 255 ] && s=254; exit $s",
        shell_line(dir, "")
    )
}

/// 원격 명령 맨 앞의 연결 표시(창 제목 minmo-link) — 이 PC 가 새 ssh 의 연결을 안다(#89). 뒤의 짧은 대기는 ConPTY 가
/// 한 번의 화면 갱신에 마지막 제목만 보내 표시가 바로 다음 제목(tmux·프롬프트)에 덮이지 않게 한다(소수 초를 못 받는 sleep 은 1초)
const LINK_MARKER: &str = "printf '\\033]2;minmo-link\\007'; sleep 0.2 2>/dev/null || sleep 1; ";

/// 원격 셸에서 실행할 한 줄. tmux 서버는 처음 실행한 cwd 를 가진 채 남으므로(그 worktree 를 지울 때 걸린다)
/// 홈에서 시작하고 세션의 시작 폴더만 worktree 로 준다
pub(crate) fn remote_shell_command(r: &RemotePty, path: &str) -> Result<String, String> {
    remote_body(r, path).map(|body| format!("{LINK_MARKER}{body}"))
}

fn remote_body(r: &RemotePty, path: &str) -> Result<String, String> {
    if !path.starts_with('/') {
        return Err(format!("원격 경로는 절대 경로여야 합니다: {path}"));
    }
    let dir = ssh::quote(path);
    match &r.session {
        None => Ok(login_shell(&dir)),
        Some(name) => {
            if name.is_empty()
                || !name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err(format!("tmux 세션 이름이 올바르지 않습니다: {name}"));
            }
            let tag = ssh::quote(path.trim_end_matches('/'));
            // -u: 원격 로케일이 UTF-8 이 아니어도 UTF-8 로 그린다(xterm 은 항상 UTF-8) — 없으면 한글이 '_' 로 나온다.
            // 분할 패널의 세션은 끊겨도 남아 다시 붙는다(패널을 닫을 때 화면이 끝낸다) — 이전 버전이 켠 destroy-unattached 를 끈다(EC-11)
            let ephemeral = if r.ephemeral {
                " \\; set-option destroy-unattached off"
            } else {
                ""
            };
            // 창 제목으로 "지금 도는 프로그램 이름:그 프로그램이 정한 제목" 을 내보내게 한다 — 앱이 이것으로 에이전트의
            // 종류와 상태를 안다(tmux 는 기본으로 안쪽 프로그램의 제목을 바깥 터미널에 전달하지 않는다). 이 세션에만 켠다 —
            // 전용 서버 전체(-g)에 켜면 같은 서버에 붙은 다른 클라이언트(이전 버전 원격 CLI 의 `minmo open` 등)의 터미널 제목까지 바뀐다
            let titles = ssh::quote(TMUX_TITLE_FORMAT);
            // 세션을 새로 만들 때 첫 창의 셸(이미 있는 세션에 붙을 때는 tmux 가 무시한다). tmux 는 이 명령을 기본 셸로
            // 실행하므로 sh 에 넘긴다
            let shell = ssh::quote(&ssh::sh_wrap(&worktree_shell(&dir)));
            Ok(format!(
                "cd && exec tmux -u -L minmo new-session -A -s {name} -c {dir} {shell} \\; set-option @minmo_worktree {tag}{ephemeral} \\; set-option set-titles on \\; set-option set-titles-string {titles}"
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

/// 기본 Spawner — 지금 호스트 정보로 ssh 인자를 만들어(시도마다 새로 읽는다, EC-07) PTY 로 연다
fn open_remote(r: &RemotePty, cwd: &str, cols: u16, rows: u16) -> Result<Opened, String> {
    open_proc(remote_shell(r, cwd)?, cols, rows)
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// 새로 연 프로세스와 그 출력
pub(crate) struct Opened {
    pub(crate) proc: Proc,
    pub(crate) reader: Box<dyn Read + Send>,
}

/// 명령을 PTY 로 띄운다
pub(crate) fn open_proc(mut cmd: CommandBuilder, cols: u16, rows: u16) -> Result<Opened, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(err)?;
    // ConPTY 를 열면 호스트가 뜬다 — 앱이 닫지 못하고 끝나도 남지 않게
    #[cfg(windows)]
    adopt_console_hosts();
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave);
    #[cfg(windows)]
    let job = child
        .process_id()
        .and_then(job::Job::for_process)
        .map(Arc::new);
    let reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;
    Ok(Opened {
        proc: Proc {
            master: pair.master,
            writer,
            child,
            cpr_answered: false,
            cpr_reply: CURSOR_HOME_REPORT.to_vec(),
            shared: Arc::default(),
            #[cfg(windows)]
            job,
        },
        reader,
    })
}

/// ConPTY 호스트를 넣는 앱 전체 Job — 앱이 어떻게 끝나든(충돌·강제 종료·업데이트 설치) 핸들이 닫히며 OS 가 호스트를 끝낸다.
/// 일부 OpenConsole 은 부모가 ConPTY 를 닫지 않고 끝나면 끊긴 파이프에서 CPU 한 코어를 계속 쓴다(#100).
/// 세션의 Job 과 따로 둔다 — 세션의 Job 은 ConPTY 를 닫기 전에 끝내므로(terminate) 호스트가 들면 닫기보다 먼저 끝난다
#[cfg(windows)]
static CONSOLE_HOSTS: OnceLock<Option<job::Job>> = OnceLock::new();

/// 이 프로세스의 ConPTY 호스트를 모두 앱 전체 Job 에 넣는다(이미 든 것은 그대로) — ConPTY 를 연 직후에 부른다
#[cfg(windows)]
fn adopt_console_hosts() {
    if let Some(job) = CONSOLE_HOSTS.get_or_init(job::Job::new) {
        for pid in console_hosts() {
            job.assign(pid);
        }
    }
}

/// 이 프로세스가 띄운 ConPTY 호스트(OpenConsole·conhost)의 pid. ConPTY 호스트는 이 프로세스의 직접 자식이다 —
/// 일반 콘솔 프로그램의 conhost 는 그 프로그램의 자식이라 들지 않는다
#[cfg(windows)]
fn console_hosts() -> Vec<u32> {
    let me = std::process::id();
    super::procs::snapshot()
        .into_iter()
        .filter(|(_, ppid, name)| {
            *ppid == me
                && (name.eq_ignore_ascii_case("OpenConsole.exe")
                    || name.eq_ignore_ascii_case("conhost.exe"))
        })
        .map(|(pid, ..)| pid)
        .collect()
}

/// 쓰지 않을 새 Proc(재접속 시도 중 세션이 없어짐)를 백그라운드에서 정리한다. 출력을 비우는 리더를 붙여 둔다 —
/// ConPTY 닫기가 남은 출력을 내보내지 못해 멈추지 않게(시작 질의에는 terminate 가 답한다)
pub(crate) fn discard(o: Opened) {
    let mut reader = o.reader;
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(1..) = reader.read(&mut buf) {}
    });
    let proc = o.proc;
    std::thread::spawn(move || kill_and_close(vec![proc]));
}

/// 터미널 하나를 여는 요청
pub(crate) struct SpawnReq {
    pub(crate) key: Option<String>,
    pub(crate) cwd: String,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) remote: Option<RemotePty>,
}

/// key(화면의 패널 id)가 있고 그 패널의 터미널이 이미 떠 있으면 새로 만들지 않고 그 id 를 돌려준다 —
/// 이 PC 의 창과 원격 접속한 기기가 같은 터미널을 함께 쓴다.
/// (app 은 원격 호출(remote.rs)과 같은 인자를 두려고 남긴다 — 알림은 setup 에서 넣은 Sink 로 간다)
#[tauri::command]
pub fn pty_spawn(
    _app: AppHandle,
    state: State<'_, PtyState>,
    cwd: String,
    cols: u16,
    rows: u16,
    remote: Option<RemotePty>,
    key: Option<String>,
) -> Result<String, String> {
    let hub = &state.hub;
    let req = SpawnReq {
        key,
        cwd,
        cols,
        rows,
        remote,
    };
    let Some(k) = &req.key else {
        return spawn_session(hub, req);
    };
    // 찾기와 만들기를 한 묶음으로 — 그 사이에 다른 화면이 같은 패널을 열면 셸이 두 개 뜬다
    let _opening = hub.opening.lock().map_err(err)?;
    if let Some(found) = find(hub, k)? {
        return Ok(found.id);
    }
    spawn_session(hub, req)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyFound {
    pub(crate) id: String,
    /// 지금까지의 출력 — 붙는 화면이 먼저 그린다
    pub(crate) scrollback: String,
    /// scrollback 이 담은 마지막 위치(전체 출력 길이) — 이보다 뒤의 pty-data 만 이어서 그린다
    pub(crate) offset: u64,
    cols: u16,
    rows: u16,
    /// 지금 연결 상태 — 늦게 붙은 화면이 재접속 중·실패 안내로 바로 시작한다(AC-09)
    pub(crate) link: LinkView,
    /// 원격 tmux 세션 — 화면이 분할 패널을 닫을 때 그 세션을 끝낸다(원격이 아니거나 tmux 를 안 쓰면 null)
    pub(crate) tmux: Option<PtyTmux>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyTmux {
    pub(crate) session: String,
    pub(crate) ephemeral: bool,
}

impl PtyTmux {
    fn of(r: &RemotePty) -> Option<Self> {
        r.session.clone().map(|session| Self {
            session,
            ephemeral: r.ephemeral,
        })
    }
}

/// 세션을 목록에서 뺀다 — 감독 통로를 먼저 닫아 감독이 세션이 없어진 것을 알게 한다(그 감독이 pty-exit 를 낸다)
pub(crate) fn take(sessions: &mut HashMap<String, PtySession>, id: &str) -> Option<PtySession> {
    let mut s = sessions.remove(id)?;
    drop(s.tx.take());
    Some(s)
}

/// key 의 터미널이 살아 있으면 돌려준다. 셸이 끝난 로컬 터미널은 치운다(그 패널은 새 터미널을 만들 수 있다).
/// 원격 터미널은 끊겨도 치우지 않는다 — 재접속 감독이 끝을 정한다
pub(crate) fn find(hub: &Hub, key: &str) -> Result<Option<PtyFound>, String> {
    let ended = {
        let mut sessions = hub.sessions.lock().map_err(err)?;
        let Some(id) = sessions
            .iter()
            .find(|(_, s)| s.key.as_deref() == Some(key))
            .map(|(id, _)| id.clone())
        else {
            return Ok(None);
        };
        let s = sessions.get_mut(&id).ok_or("pty 없음")?;
        if s.remote.is_some() || s.proc.alive() {
            let (scrollback, offset, repaint) = {
                let sb = s.scrollback.lock().map_err(err)?;
                let (text, repaint) = sb.restore();
                (text, sb.total, repaint)
            };
            // 크기를 한 줄 줄였다 되돌리면 ConPTY 와 전체 화면 프로그램이 화면 전체를 다시 보낸다. 그 출력은 offset 뒤의
            // pty-data 로 가므로 붙는 화면이 이어서 그린다. 크기는 그대로이므로 pty-resized 는 알리지 않는다.
            // 재접속을 기다리는 동안(Waiting·Failed)의 PTY 는 끝난 ssh 의 것이라 건드리지 않는다
            if repaint && s.link.running() && s.rows > 1 {
                for rows in [s.rows - 1, s.rows] {
                    let _ = s.proc.set_size(s.cols, rows);
                }
            }
            return Ok(Some(PtyFound {
                id,
                scrollback,
                offset,
                cols: s.cols,
                rows: s.rows,
                link: LinkView::from(&s.link),
                tmux: s.remote.as_ref().and_then(PtyTmux::of),
            }));
        }
        take(&mut sessions, &id)
    };
    if let Some(s) = ended {
        std::thread::spawn(move || kill_and_close(vec![s.proc]));
    }
    Ok(None)
}

/// 패널(key)의 터미널이 이미 떠 있으면 그 id 와 지금까지의 출력을 돌려준다(없으면 null)
#[tauri::command]
pub fn pty_find(state: State<'_, PtyState>, key: String) -> Result<Option<PtyFound>, String> {
    find(&state.hub, &key)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    id: String,
    key: Option<String>,
    cwd: String,
    host: Option<String>,
}

/// 떠 있는 터미널 목록 — 원격 화면이 열어 보지 않은 이슈의 에이전트 상태도 알 수 있게 한다
#[tauri::command]
pub fn pty_list(state: State<'_, PtyState>) -> Result<Vec<PtyInfo>, String> {
    let sessions = state.hub.sessions.lock().map_err(err)?;
    Ok(sessions
        .iter()
        .map(|(id, s)| PtyInfo {
            id: id.clone(),
            key: s.key.clone(),
            cwd: s.cwd.clone(),
            host: s.host().map(str::to_string),
        })
        .collect())
}

/// 터미널을 연다. 원격 세션에는 재접속 감독을 붙인다 — 그 뒤로 끝(pty-exit)은 감독이 정한다
pub(crate) fn spawn_session(hub: &Arc<Hub>, req: SpawnReq) -> Result<String, String> {
    let opened = match &req.remote {
        Some(r) => (hub.spawner)(r, &req.cwd, req.cols, req.rows)?,
        None => {
            let mut cmd = CommandBuilder::new(default_shell());
            cmd.cwd(&req.cwd);
            open_proc(cmd, req.cols, req.rows)?
        }
    };
    let id = format!("pty-{}", hub.seq.fetch_add(1, Ordering::SeqCst) + 1);
    let supervisor = req
        .remote
        .as_ref()
        .and_then(|_| hub.supervisor.get().copied());
    let (tx, rx) = supervisor.map(|_| mpsc::channel()).unzip();
    // 첫 세대도 연결 신호 전까지 출력을 모은다 — 처음 열 때의 인증 실패도 가린다(AC-11·EC-01)
    opened.proc.shared.set_collecting(req.remote.is_some());
    let session = PtySession {
        proc: opened.proc,
        cwd: req.cwd,
        key: req.key,
        scrollback: Arc::default(),
        cols: req.cols,
        rows: req.rows,
        remote: req.remote,
        gen: Arc::default(),
        link: Link::default(),
        tx,
    };
    let reader = Reader::new(hub, &id, &session, opened.reader);
    // 리더 스레드보다 먼저 넣는다 — 리더가 시작 질의를 읽자마자 이 세션으로 답할 수 있게
    hub.sessions
        .lock()
        .map_err(err)?
        .insert(id.clone(), session);
    reader.start();
    if let (Some(start), Some(rx)) = (supervisor, rx) {
        let (hub, id) = (hub.clone(), id.clone());
        std::thread::spawn(move || start(hub, id, rx));
    }
    Ok(id)
}

/// 재접속 시도: 새 Proc 를 다음 세대로 넣는다(세션 잠금 안). 시도 알림 → 준비 시퀀스 순서로 내고 옛 Proc 와 새 리더를
/// 돌려준다 — 둘 다 잠금을 놓은 뒤 처리한다. spawned 는 새 PTY 를 연 크기(그 사이 바뀌었으면 맞춘다)
pub(crate) fn swap_in(
    hub: &Arc<Hub>,
    id: &str,
    s: &mut PtySession,
    opened: Opened,
    spawned: (u16, u16),
) -> (Proc, Reader) {
    // 거울을 먼저 올린다 — 옛 리더가 Scrollback 잠금 안에서 세대를 보고 준비 시퀀스 뒤에는 끼지 않는다
    s.begin_attempt();
    let Opened { mut proc, reader } = opened;
    let rows = s.rows;
    proc.cpr_reply = pty_link::cpr_reply(rows).into_bytes();
    proc.shared.set_connecting(true);
    proc.shared.set_collecting(true);
    // tmux 는 다시 붙으면 제목을 다시 보내므로 지우지 않는다(에이전트 감지가 제목을 잃지 않게)
    let clear_title = s.remote.as_ref().is_some_and(|r| r.session.is_none());
    let prelude = s
        .scrollback
        .lock()
        .map(|mut sb| sb.reattach(rows, clear_title))
        .unwrap_or_default();
    announce(hub, id, s, Some(prelude));
    let old = std::mem::replace(&mut s.proc, proc);
    if spawned != (s.cols, s.rows) {
        let _ = s.proc.set_size(s.cols, s.rows);
    }
    let reader = Reader::new(hub, id, s, reader);
    (old, reader)
}

/// 리더 스레드(세대마다 하나): 출력을 보관하고 화면에 보낸다
pub(crate) struct Reader {
    hub: Arc<Hub>,
    id: String,
    /// 이 리더의 세대
    gen: u64,
    /// 세션의 지금 세대(거울)
    current: Arc<AtomicU64>,
    scrollback: Arc<Mutex<Scrollback>>,
    shared: Arc<GenShared>,
    /// 원격 세션 — 연결 신호(표시·tmux 제목)를 찾는다
    filter: Option<MarkerFilter>,
    /// 감독이 있다 — 끝(EOF)을 감독에게 넘기고 pty-exit 는 내지 않는다
    supervised: bool,
    source: Box<dyn Read + Send>,
}

impl Reader {
    /// 세션의 지금 Proc 를 읽는 리더. 세션을 잠근 채(또는 넣기 전에) 만든다
    pub(crate) fn new(
        hub: &Arc<Hub>,
        id: &str,
        s: &PtySession,
        source: Box<dyn Read + Send>,
    ) -> Self {
        Self {
            hub: hub.clone(),
            id: id.to_string(),
            gen: s.link.gen,
            current: s.gen.clone(),
            scrollback: s.scrollback.clone(),
            shared: s.proc.shared.clone(),
            filter: s
                .remote
                .as_ref()
                .map(|r| MarkerFilter::new(r.session.is_some())),
            supervised: s.tx.is_some(),
            source,
        }
    }

    pub(crate) fn start(self) {
        std::thread::spawn(move || self.run());
    }

    fn run(mut self) {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        let mut startup = StartupQuery::new();
        loop {
            match self.source.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let (text, query) = startup.filter(take_utf8(&mut pending));
                    if query {
                        self.answer_query();
                    }
                    if !text.is_empty() {
                        self.output(text);
                    }
                }
            }
        }
        self.ended();
    }

    /// 시작 질의에 세션의 지금 Proc(이 세대)로 답한다. 세션이 빠졌거나 세대가 바뀌었으면 그 Proc 를 정리하는 terminate() 가 답한다
    fn answer_query(&self) {
        let Ok(mut sessions) = self.hub.sessions.lock() else {
            return;
        };
        if let Some(s) = sessions
            .get_mut(&self.id)
            .filter(|s| s.link.gen == self.gen)
        {
            s.proc.answer_startup_query();
        }
    }

    fn output(&mut self, mut text: String) {
        let Some(mut filter) = self.filter.take() else {
            self.emit(text);
            return;
        };
        // 신호를 만나면 앞 텍스트 → 상태 알림(과 구분 줄) → 나머지 순서로 낸다
        loop {
            let strip = self.shared.connecting.load(Ordering::SeqCst);
            let (head, signal) = filter.filter(&text, strip);
            if !head.is_empty() && !self.emit(head) {
                break;
            }
            let Some((signal, rest)) = signal else { break };
            self.signal(signal);
            if rest.is_empty() {
                break;
            }
            text = rest;
        }
        self.filter = Some(filter);
    }

    /// 출력 한 조각을 보관하고 화면에 보낸다. Scrollback 잠금 안에서 세대를 확인해 옛 세대의 조각은 버린다 —
    /// 감독이 세대를 올린 뒤 넣는 준비 시퀀스 뒤에 끼지 않게. 버렸으면 false
    fn emit(&self, text: String) -> bool {
        let mut sb = self.scrollback.lock().ok();
        if self.current.load(Ordering::SeqCst) != self.gen {
            return false;
        }
        if self.shared.collecting.load(Ordering::SeqCst) {
            self.shared.push_tail(&text);
        }
        push_and_emit(&self.hub, &self.id, sb.as_deref_mut(), text);
        true
    }

    /// 연결 신호 — 세션 잠금 안에서 세대를 다시 확인하고 상태를 바꾼다. 이미 연결 신호를 본 세대는 바뀔 것이 없다
    fn signal(&self, signal: Signal) {
        if !self.shared.collecting.load(Ordering::SeqCst) {
            return;
        }
        let Ok(mut sessions) = self.hub.sessions.lock() else {
            return;
        };
        let Some(s) = sessions.get_mut(&self.id) else {
            return;
        };
        if s.link.gen != self.gen {
            return;
        }
        let seq = s.link.seq;
        let separate = pty_link::on_marker(&mut s.link, self.gen, &now_hhmm());
        if s.link.connected {
            self.shared.set_collecting(false);
        }
        if s.link.phase == Phase::Live {
            self.shared.set_connecting(false);
        }
        if s.link.seq == seq {
            return;
        }
        // 구분 줄은 연결 표시(minmo-link)로 알았을 때만 넣는다 — tmux 제목으로 먼저 알았으면 커서가 어디인지 모른다
        // (화면의 "다시 접속했습니다" 안내가 알린다, D-25). 준비 시퀀스가 대체 화면을 먼저 꺼 두므로 !alt 는 사실상
        // 늘 참인 방어 검사다. tmux 재접속도 표시가 tmux 제목보다 먼저 와서 구분 줄은 tmux 화면 앞 일반 화면에
        // 들어간다(화면에서는 tmux 가 덮는다)
        let alt = s.scrollback.lock().map_or(true, |sb| sb.alt_screen());
        let inject = (separate && signal == Signal::Marker && !alt)
            .then(|| pty_link::separator(s.link.at.as_deref().unwrap_or_default()));
        announce(&self.hub, &self.id, s, inject);
    }

    /// 출력이 끝났다(셸·ssh 종료). 감독이 있는 원격 세션은 지금 세대일 때만 감독에게 넘긴다(옛 세대는 아무것도 하지 않는다).
    /// 그 밖에는 화면에 알리고 세션을 치운다
    fn ended(self) {
        if self.supervised {
            let Ok(sessions) = self.hub.sessions.lock() else {
                return;
            };
            let own = sessions.get(&self.id).filter(|s| s.link.gen == self.gen);
            if let Some(tx) = own.and_then(|s| s.tx.as_ref()) {
                let _ = tx.send(Ev::Eof { gen: self.gen });
            }
            return;
        }
        if let Some(sink) = self.hub.sink() {
            sink.exit(&self.id);
        }
        if let Ok(Some(s)) = take_by_id(&self.hub, &self.id) {
            kill_and_close(vec![s.proc]);
        }
    }
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    write(&state.hub, &id, &data)
}

pub(crate) fn write(hub: &Hub, id: &str, data: &str) -> Result<(), String> {
    let mut sessions = hub.sessions.lock().map_err(err)?;
    let s = sessions
        .get_mut(id)
        .ok_or_else(|| format!("pty {id} 없음"))?;
    // 끊긴 동안(재접속 중·실패)의 입력은 버린다 — 오류로 돌려주면 화면이 "종료"로 읽는다(EC-02)
    if s.link.phase != Phase::Live {
        return Ok(());
    }
    let written = s.proc.write_input(data.as_bytes());
    // 원격은 끊긴 직후(감독이 알기 전) 죽은 입력 파이프에 쓰는 구간이 있다 — 원격의 끝은 pty-exit 로만 알린다
    if s.remote.is_some() {
        return Ok(());
    }
    written.map_err(err)
}

#[derive(Clone, Serialize)]
struct PtyResized {
    id: String,
    cols: u16,
    rows: u16,
    /// 크기를 바꾼 화면이 보낸 표시 — 그 화면이 늦게 받은 자기 알림을 다른 화면의 변경으로 읽지 않게 그대로 돌려준다
    by: Option<String>,
}

/// (app 은 pty_spawn 과 같은 이유로 남긴다)
#[tauri::command]
pub fn pty_resize(
    _app: AppHandle,
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
    by: Option<String>,
) -> Result<(), String> {
    resize(&state.hub, &id, cols, rows, by)
}

pub(crate) fn resize(
    hub: &Hub,
    id: &str,
    cols: u16,
    rows: u16,
    by: Option<String>,
) -> Result<(), String> {
    let mut sessions = hub.sessions.lock().map_err(err)?;
    let s = sessions
        .get_mut(id)
        .ok_or_else(|| format!("pty {id} 없음"))?;
    // 재접속을 기다리는 동안(Waiting·Failed)은 크기만 기록한다 — 다음 시도가 이 크기로 연다
    if (s.cols != cols || s.rows != rows) && s.link.running() {
        let resized = s.proc.set_size(cols, rows);
        // 원격은 끊긴 직후의 죽은 ConPTY 일 수 있다 — 크기는 기록해 다음 시도에 쓴다
        if s.remote.is_none() {
            resized?;
        }
    }
    s.cols = cols;
    s.rows = rows;
    // 같은 터미널을 보는 다른 화면이 같은 크기로 그리게 알린다. 크기가 그대로여도 알린다 — 요청한 화면이 요청마다 답을
    // 하나씩 받아야 "마지막 요청이 적용됐다"를 알 수 있다. 잠근 채로 알린다 — 원격 호출은 따로 돌아 동시에 올 수 있는데,
    // 알림 순서가 적용 순서와 같아야 화면들이 받은 마지막 알림이 곧 PTY 의 크기다
    if let Some(sink) = hub.sink() {
        sink.resized(id, cols, rows, by);
    }
    drop(sessions);
    Ok(())
}

/// 화면(xterm)의 windowsPty 옵션 값 — 이 PC 의 터미널이 쓰는 ConPTY 와 그 Windows 빌드 번호
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsPty {
    backend: &'static str,
    build_number: u32,
}

/// 터미널이 Windows ConPTY 위에서 돌면 그 정보를, 아니면 None 을 돌려준다.
/// xterm 은 이 값으로 ConPTY 와 같은 방식으로 크기를 바꾼다(행이 늘면 스크롤백을 끌어오지 않고 아래에 빈 행을 둔다).
/// 원격(ssh) 터미널도 이 PC 의 ConPTY 를 거친다. 빌드 번호는 OS 의 것이다 — portable-pty 는 DLL 검색 경로(PATH 포함)에서
/// conpty.dll 을 찾으면(예: WezTerm 의 것) 그것을 쓰므로, 그때는 실제 ConPTY 의 버전과 다를 수 있다
#[tauri::command]
pub fn pty_windows() -> Option<WindowsPty> {
    windows_build().map(|build_number| WindowsPty {
        backend: "conpty",
        build_number,
    })
}

#[cfg(windows)]
fn windows_build() -> Option<u32> {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    // GetVersionEx 는 매니페스트가 없으면 8 이후의 버전을 감춘다 — RtlGetVersion 은 실제 버전을 돌려준다
    // SAFETY: 크기를 채운 구조체를 넘기고, 성공(STATUS_SUCCESS)일 때만 값을 읽는다
    unsafe {
        let mut info: OSVERSIONINFOW = std::mem::zeroed();
        info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
        (RtlGetVersion(&mut info) == 0).then_some(info.dwBuildNumber)
    }
}

#[cfg(not(windows))]
fn windows_build() -> Option<u32> {
    None
}

/// ConPTY 닫기 대기 상한. 정상 닫기는 수십 ms 이고, 이 시간이 지나도 닫히지 않는 세션은 포기한다
const CLOSE_DEADLINE: Duration = Duration::from_secs(3);

/// 모든 셸(과 자손)을 끝낸 뒤 ConPTY 를 닫고, 마감 안에 닫힌 세션 수를 돌려준다(블로킹).
/// 정리 순서를 지키도록 닫힐 때까지 기다리되, 한 세션의 닫기가 멈춰도 다른 세션과 호출자(worktree 삭제)가
/// 막히지 않도록 세션마다 스레드를 두고 공통 마감까지만 기다린다.
pub(crate) fn kill_and_close(mut procs: Vec<Proc>) -> usize {
    for p in &mut procs {
        p.terminate();
    }
    let total = procs.len();
    let (tx, rx) = mpsc::channel();
    for p in procs {
        let tx = tx.clone();
        std::thread::spawn(move || {
            p.close();
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
    let procs = sessions.into_iter().map(|s| s.proc).collect();
    tauri::async_runtime::spawn_blocking(move || kill_and_close(procs))
        .await
        .map(|_| ())
        .map_err(err)
}

/// 이 터미널의 셸 아래에서 도는 프로세스 이름들 — 어떤 에이전트(claude·codex 등)가 떠 있는지 감지할 때 쓴다.
/// 원격(ssh) 세션은 이 PC 에서 ssh 만 보이므로 빈 목록이다(원격은 터미널 제목으로 감지한다).
#[tauri::command]
pub async fn pty_processes(state: State<'_, PtyState>, id: String) -> Result<Vec<String>, String> {
    let pid = {
        let sessions = state.hub.sessions.lock().map_err(err)?;
        match sessions.get(&id) {
            Some(s) if s.remote.is_none() => s.proc.child.process_id(),
            _ => None,
        }
    };
    match pid {
        // 프로세스 목록 조회는 잠깐 블로킹된다 — 메인(UI) 스레드에서 하지 않는다
        Some(pid) => {
            tauri::async_runtime::spawn_blocking(move || super::procs::descendant_names(pid))
                .await
                .map_err(err)
        }
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let removed = take_by_id(&state.hub, &id)?;
    kill_sessions(removed.into_iter().collect()).await
}

/// id 의 터미널을 목록에서 뺀다 — 끝내기(kill_and_close)는 호출자가 잠금 밖에서
pub(crate) fn take_by_id(hub: &Hub, id: &str) -> Result<Option<PtySession>, String> {
    Ok(take(&mut *hub.sessions.lock().map_err(err)?, id))
}

/// 모든 PTY 를 백그라운드에서 끝낸다 — 웹뷰가 새로 고쳐지면(React 정리가 돌지 않음) 남은 셸·에이전트를 정리한다
pub fn kill_all(state: &PtyState) {
    kill_all_in(&state.hub);
}

/// 화면이 다시 찾을 수 없는 세션(패널 id 가 없는 것)만 끝낸다 — main 을 새로 고쳤지만 보조 창(#105)이 남은 터미널을 쓰고 있을 때.
/// 패널 id 가 있는 세션은 새로 고친 화면과 보조 창이 pty_find 로 다시 붙는다
pub fn kill_unkeyed(state: &PtyState) {
    let procs: Vec<Proc> = match state.hub.sessions.lock() {
        Ok(mut s) => {
            let ids: Vec<String> = s.iter().filter(|(_, v)| v.key.is_none()).map(|(k, _)| k.clone()).collect();
            ids.iter().filter_map(|id| s.remove(id)).map(|v| v.proc).collect()
        }
        Err(_) => return,
    };
    if !procs.is_empty() {
        std::thread::spawn(move || kill_and_close(procs));
    }
}

pub(crate) fn kill_all_in(hub: &Hub) {
    let procs = drain(hub);
    if !procs.is_empty() {
        std::thread::spawn(move || kill_and_close(procs));
    }
}

/// 앱이 끝날 때 — 남은 터미널을 모두 끝내고 ConPTY 가 닫힐 때까지(세션마다 마감) 기다린 뒤, 마감 안에 닫힌 수를 돌려준다.
/// ConPTY 를 닫지 않고 끝나면 일부 OpenConsole 이 끊긴 파이프에서 CPU 한 코어를 계속 쓴다(#100)
pub fn close_all(state: &PtyState) -> usize {
    kill_and_close(drain(&state.hub))
}

/// 모든 세션을 목록에서 뺀다. 감독 통로는 세션과 함께 바로 버려진다 — 감독마다 pty-exit 를 한 번 낸다. 원격 tmux 세션은 남는다(EC-08)
fn drain(hub: &Hub) -> Vec<Proc> {
    hub.sessions
        .lock()
        .map(|mut s| s.drain().map(|(_, v)| v.proc).collect())
        .unwrap_or_default()
}

/// 같은 호스트(None = 이 PC)의 세션이고 cwd 가 path 와 같거나 그 하위인가
fn in_target(s: &PtySession, path: &str, host: Option<&str>) -> bool {
    if s.host() != host {
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
    let targets = take_by_cwd(&state.hub, &path, host.as_deref())?;
    let n = targets.len() as u32;
    kill_sessions(targets).await?;
    Ok(n)
}

/// cwd 가 path(또는 하위)인 터미널을 목록에서 빼서 돌려준다
pub(crate) fn take_by_cwd(
    hub: &Hub,
    path: &str,
    host: Option<&str>,
) -> Result<Vec<PtySession>, String> {
    let mut sessions = hub.sessions.lock().map_err(err)?;
    let ids: Vec<String> = sessions
        .iter()
        .filter(|(_, s)| in_target(s, path, host))
        .map(|(id, _)| id.clone())
        .collect();
    Ok(ids
        .iter()
        .filter_map(|id| take(&mut sessions, id))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_windows_reports_conpty_build_only_on_windows() {
        let info = pty_windows();
        if cfg!(windows) {
            let info = info.expect("Windows 에서는 ConPTY 정보가 있어야 한다");
            assert_eq!(info.backend, "conpty");
            // ConPTY 는 Windows 10 1809(17763)부터 있다
            assert!(info.build_number >= 17763, "{}", info.build_number);
        } else {
            assert!(info.is_none());
        }
    }

    fn remote(session: Option<&str>, ephemeral: bool) -> RemotePty {
        RemotePty {
            host: "h".into(),
            session: session.map(str::to_string),
            ephemeral,
        }
    }

    /// 원격 명령 맨 앞의 연결 표시와 짧은 대기(#89)
    const MARKER: &str = "printf '\\033]2;minmo-link\\007'; sleep 0.2 2>/dev/null || sleep 1; ";

    #[test]
    fn remote_shell_command_attaches_tmux_or_opens_a_login_shell() {
        // 맨 앞에 연결 표시를 낸다. bash 는 시작 파일을 읽은 뒤 worktree 로 돌아오고, 그 밖의 셸은 로그인 셸 그대로다.
        // 로그인 셸은 exec 하지 않고 기다려 종료 코드 255 만 254 로 바꿔 넘긴다(D-27 — ssh 의 255 와 가린다)
        let plain = remote_shell_command(&remote(None, false), "/w/it's").unwrap();
        let body = plain
            .strip_prefix(MARKER)
            .unwrap_or_else(|| panic!("표시가 맨 앞에 없다: {plain}"));
        assert!(body.starts_with(
            "cd -- '/w/it'\\''s' && export MINMO_WORKTREE='/w/it'\\''s' && case \"${SHELL##*/}\" in bash) \"$SHELL\" -c 'exec \"$0\" --rcfile /dev/fd/3 -i 3<<<\"$1\"' \"$SHELL\" 'exec 3<&-; [ -r /etc/profile ] && . /etc/profile; "
        ), "{body}");
        assert!(
            body.ends_with("cd -- \"$MINMO_WORKTREE\"' ;; *) \"${SHELL:-sh}\" -l ;; esac; s=$?; [ $s -eq 255 ] && s=254; exit $s"),
            "{body}"
        );
        // tmux 의 첫 창도 같은 셸을 연다(sh 에 넘기고 한 번 더 인용한다). 셸로 바뀌므로(exec) 255 를 바꾸지 않는다
        let shell = ssh::quote(&ssh::sh_wrap(&worktree_shell("'/w/t/'")));
        assert!(shell.contains("bash) exec \"$SHELL\""), "{shell}");
        assert!(!shell.contains("254"), "{shell}");
        assert_eq!(
            remote_shell_command(&remote(Some("minmo-0a1b2c3d4e"), false), "/w/t/").unwrap(),
            format!("{MARKER}cd && exec tmux -u -L minmo new-session -A -s minmo-0a1b2c3d4e -c '/w/t/' {shell} \\; set-option @minmo_worktree '/w/t' \\; set-option set-titles on \\; set-option set-titles-string 'minmo:#{{pane_current_command}}:#{{pane_title}}'")
        );
        // 분할 패널의 세션은 끊겨도 남는다 — 이전 버전이 켠 destroy-unattached 도 끈다(EC-11)
        let split =
            remote_shell_command(&remote(Some("minmo-0a1b2c3d4e-p2"), true), "/w/t").unwrap();
        assert!(
            split.contains("\\; set-option destroy-unattached off \\; set-option set-titles on"),
            "{split}"
        );
        assert!(!split.contains("destroy-unattached on"), "{split}");
    }

    /// 화면 계약(#89 Plan §7): pty-link `{ id, phase, attempt, max, seq, reason, at }`, PtyFound.tmux `{ session, ephemeral }`
    #[test]
    fn pty_link_event_and_tmux_serialize_to_the_screen_contract() {
        let waiting = Link {
            phase: Phase::Waiting,
            attempt: 2,
            seq: 7,
            ..Link::default()
        };
        let ev = PtyLinkEvent {
            id: "pty-1".into(),
            link: LinkView::from(&waiting),
        };
        assert_eq!(
            serde_json::to_value(&ev).unwrap(),
            serde_json::json!({ "id": "pty-1", "phase": "waiting", "attempt": 2, "max": 5, "seq": 7, "reason": null, "at": null })
        );
        let failed = Link {
            phase: Phase::Failed,
            reason: Some("auth"),
            ..Link::default()
        };
        assert_eq!(
            serde_json::to_value(LinkView::from(&failed)).unwrap()["reason"],
            "auth"
        );
        let live = Link {
            at: Some("14:02".into()),
            ..Link::default()
        };
        let live = serde_json::to_value(LinkView::from(&live)).unwrap();
        assert_eq!(
            (live["phase"].as_str(), live["at"].as_str()),
            (Some("connected"), Some("14:02"))
        );
        assert_eq!(
            serde_json::to_value(PtyTmux::of(&remote(Some("minmo-a-p2"), true))).unwrap(),
            serde_json::json!({ "session": "minmo-a-p2", "ephemeral": true })
        );
        assert_eq!(PtyTmux::of(&remote(None, false)), None);
    }

    #[test]
    fn remote_shell_command_rejects_bad_session_names_and_relative_paths() {
        assert!(remote_shell_command(&remote(Some("a;b"), false), "/w").is_err());
        assert!(remote_shell_command(&remote(Some(""), false), "/w").is_err());
        assert!(remote_shell_command(&remote(None, false), "w/t").is_err());
    }

    #[test]
    fn scrollback_keeps_recent_output_and_cuts_at_a_line_boundary() {
        let mut sb = Scrollback::default();
        sb.push("first\n");
        assert_eq!(sb.text, "first\n");
        // 상한을 넘기면 앞에서 버리고, 남은 것은 줄의 처음부터 시작한다(한글이 잘리지 않는다)
        let line = "가나다라마바사아자차카타파하\n";
        for _ in 0..(SCROLLBACK_LIMIT / line.len() + 50) {
            sb.push(line);
        }
        assert!(sb.text.len() <= SCROLLBACK_LIMIT);
        assert!(sb.text.len() > SCROLLBACK_LIMIT - 2 * line.len());
        assert!(sb.text.starts_with(line));
        assert!(!sb.text.contains("first"));
        // 줄바꿈이 없는 긴 출력도 상한을 지킨다
        let mut sb = Scrollback::default();
        let end = sb.push(&"x".repeat(SCROLLBACK_LIMIT + 10));
        assert_eq!(sb.text.len(), SCROLLBACK_LIMIT);
        // 버린 것까지 센 전체 길이를 돌려준다
        assert_eq!(end, SCROLLBACK_LIMIT as u64 + 10);
    }

    #[test]
    fn scrollback_tracks_modes_across_chunks() {
        let mut sb = Scrollback::default();
        sb.push("a\x1b[?1049h\x1b[?1000;1006hb\x1b[?25l");
        assert!(sb.alt_screen());
        assert_eq!(sb.modes.get(&1000), Some(&true));
        assert_eq!(sb.modes.get(&1006), Some(&true));
        assert_eq!(sb.modes.get(&25), Some(&false));
        // 조각 경계에서 잘린 시퀀스: ESC 뒤, `ESC[` 뒤, 번호 중간
        for (head, tail) in [
            ("x\x1b", "[?1049l"),
            ("x\x1b[", "?25h"),
            ("x\x1b[?20", "04h"),
        ] {
            sb.push(head);
            sb.push(tail);
        }
        assert!(!sb.alt_screen());
        assert_eq!(sb.modes.get(&25), Some(&true));
        assert_eq!(sb.modes.get(&2004), Some(&true));
        // 모드가 아닌 시퀀스(색·커서 이동)와 끝나지 않는 긴 시퀀스는 무시하고 다음 것을 계속 읽는다
        sb.push("\x1b[31m\x1b[2;3H\x1b[?1;2c");
        sb.push(&format!("\x1b[?{}", "1;".repeat(MODE_CARRY_LIMIT)));
        sb.push("\x1b[?1004h");
        assert_eq!(sb.modes.get(&1004), Some(&true));
        assert_eq!(sb.modes.get(&1), None);
    }

    #[test]
    fn scrollback_restore_replays_everything_until_output_is_dropped() {
        let mut sb = Scrollback::default();
        sb.push("\x1b[?1049h\x1b[2;1Hmenu");
        // 버린 것이 없으면 보관한 출력이 전부다 — 그대로 다시 그린다
        assert_eq!(
            sb.restore(),
            ("\x1b[?1049h\x1b[2;1Hmenu".to_string(), false)
        );
    }

    #[test]
    fn scrollback_restore_after_drop_rebuilds_modes_and_asks_alt_screen_to_repaint() {
        let filler = "x".repeat(SCROLLBACK_LIMIT);
        // 대체 화면: 꼬리(사라진 화면에 대한 변경분)는 버리고, 빈 대체 화면 + 모드만 돌려주며 다시 그리게 한다
        let mut sb = Scrollback::default();
        sb.push("\x1b[?1049h\x1b[?1000h\x1b[?25l");
        sb.push(&filler);
        sb.push("\x1b[5;1Hdiff");
        let (text, repaint) = sb.restore();
        assert!(repaint);
        assert_eq!(text, "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[?1000h");
        // 일반 화면: 모드를 앞에 붙이고 꼬리를 그대로 그린다
        let mut sb = Scrollback::default();
        sb.push("\x1b[?2004h");
        sb.push(&filler);
        sb.push("\nprompt> ");
        let (text, repaint) = sb.restore();
        assert!(!repaint);
        // 꼬리는 줄 경계에서 시작한다(앞의 줄바꿈까지 버린다)
        assert_eq!(text, "\x1b[?2004hprompt> ");
        // 대체 화면에서 나온 뒤에는 일반 화면으로 다룬다
        sb.push("\x1b[?1049h");
        sb.push("\x1b[?1049l");
        assert!(!sb.restore().1);
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

    fn filtered(q: &mut StartupQuery, chunk: &str) -> (String, bool) {
        q.filter(chunk.to_string())
    }

    #[test]
    fn startup_query_is_taken_out_once_after_the_conpty_preamble() {
        let mut q = StartupQuery::waiting(true);
        assert_eq!(
            filtered(&mut q, "\x1b[?9001h\x1b[?1004h\x1b[6n\x1b[mhi"),
            ("\x1b[?9001h\x1b[?1004h\x1b[mhi".to_string(), true)
        );
        // 그 뒤의 질의는 프로그램의 것이다 — 화면이 답하게 그대로 둔다
        assert_eq!(filtered(&mut q, "\x1b[6n"), ("\x1b[6n".to_string(), false));
    }

    #[test]
    fn startup_query_is_found_across_chunk_boundaries() {
        for (head, tail) in [
            ("\x1b[?9001h\x1b", "[6nok"),
            ("\x1b[?9001h\x1b[", "6nok"),
            ("\x1b[?9001h\x1b[6", "nok"),
            ("\x1b[?90", "01h\x1b[6nok"),
        ] {
            let mut q = StartupQuery::waiting(true);
            let (a, found) = filtered(&mut q, head);
            assert!(!found, "{head:?}");
            let (b, found) = filtered(&mut q, tail);
            assert!(found, "{head:?}");
            assert_eq!(a + &b, "\x1b[?9001hok", "{head:?}");
        }
    }

    #[test]
    fn startup_query_is_left_alone_when_other_output_comes_first() {
        // 글자·다른 이스케이프(OSC)가 먼저 나오면 시작 질의가 아니다 — 그만 찾는다
        for first in ["hi\x1b[6n", "\x1b]0;t\x07\x1b[6n"] {
            let mut q = StartupQuery::waiting(true);
            assert_eq!(filtered(&mut q, first), (first.to_string(), false));
            assert_eq!(filtered(&mut q, "\x1b[6n"), ("\x1b[6n".to_string(), false));
        }
        // 기다리지 않으면(Unix pty) 손대지 않는다
        let mut q = StartupQuery::waiting(false);
        assert_eq!(filtered(&mut q, "\x1b[6n"), ("\x1b[6n".to_string(), false));
    }

    #[cfg(windows)]
    mod conpty {
        use super::super::*;
        use crate::commands::pty_link::{cpr_reply, MarkerFilter, Signal};
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
            proc: ManuallyDrop<Proc>,
            output: mpsc::Receiver<Vec<u8>>,
            input_log: Arc<Mutex<Vec<u8>>>,
        }

        const ROWS: u16 = 24;

        fn cmd_exe(cwd: Option<&Path>) -> CommandBuilder {
            let mut cmd = CommandBuilder::new("cmd.exe");
            if let Some(dir) = cwd {
                cmd.cwd(dir);
            }
            cmd
        }

        /// cmd 를 PTY 로 띄우고, 앱의 리더 스레드처럼 출력을 계속 비우면서 누적 출력을 채널로 보낸다
        fn spawn_cmd_pty(cmd: CommandBuilder) -> Pty {
            let pair = native_pty_system()
                .openpty(PtySize {
                    rows: ROWS,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .unwrap();
            // 테스트가 실패해 ConPTY 를 닫지 못하고 끝나도 호스트가 남지 않게(#100)
            adopt_console_hosts();
            let child = pair.slave.spawn_command(cmd).unwrap();
            drop(pair.slave);
            let job = child
                .process_id()
                .and_then(job::Job::for_process)
                .map(Arc::new);
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
            let proc = Proc {
                master: pair.master,
                writer,
                child,
                cpr_answered: false,
                cpr_reply: CURSOR_HOME_REPORT.to_vec(),
                shared: Arc::default(),
                job,
            };
            Pty {
                proc: ManuallyDrop::new(proc),
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
            pty.proc.write_input(b"\x1b[1;1R").unwrap();
            // 입력 에코(minmo-%OS%)와 구분되도록 셸이 확장한 값을 기다린다
            pty.proc.write_input(b"echo minmo-%OS%\r").unwrap();
            wait_output(&pty.output, b"minmo-Windows_NT", "셸 응답");
        }

        /// kill_and_close 를 별도 스레드에서 실행해 멈춰도 테스트가 무한 대기하지 않게 한다.
        /// 마감 안에 닫힌 세션 수와 입력 기록을 돌려준다
        fn kill_with_timeout(pty: Pty) -> (usize, Vec<u8>) {
            let proc = ManuallyDrop::into_inner(pty.proc);
            let (done_tx, done_rx) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = done_tx.send(kill_and_close(vec![proc]));
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
            let pty = spawn_cmd_pty(cmd_exe(None));
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
            let mut pty = spawn_cmd_pty(cmd_exe(None));
            answer_cursor_query_and_wait_shell(&mut pty);
            let (closed, input) = kill_with_timeout(pty);
            assert_eq!(closed, 1, "ConPTY 가 마감 안에 닫히지 않았다");
            assert_eq!(
                count(&input, b"\x1b[1;1R"),
                1,
                "이미 응답한 세션에 다시 보내면 살아 남은 자손 프로세스에 F3 로 전달된다"
            );
        }

        /// #56: 화면 없이도 시작 질의에 답해 셸이 뜨고, 화면으로 가는 출력에는 질의가 없다(화면이 또 답하지 않는다)
        #[test]
        fn startup_query_is_answered_without_a_screen() {
            let mut pty = spawn_cmd_pty(cmd_exe(None));
            let mut startup = StartupQuery::waiting(true);
            let mut shown = String::new();
            let mut seen = 0;
            let mut typed = false;
            let deadline = Instant::now() + Duration::from_secs(10);
            while !shown.contains("minmo-Windows_NT") {
                let out = pty
                    .output
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .expect("셸 응답을 10초 안에 받지 못했다(시작 질의에 답하지 못함)");
                // 채널은 누적 출력을 보낸다 — 새로 온 부분만 거른다
                let (text, query) =
                    startup.filter(String::from_utf8_lossy(&out[seen..]).into_owned());
                seen = out.len();
                shown.push_str(&text);
                if query {
                    pty.proc.answer_startup_query();
                }
                if pty.proc.cpr_answered && !typed {
                    typed = true;
                    pty.proc.write_input(b"echo minmo-%OS%\r").unwrap();
                }
            }
            assert!(!shown.contains(CURSOR_QUERY), "시작 질의가 화면으로 갔다");
            let (closed, input) = kill_with_timeout(pty);
            assert_eq!(closed, 1, "ConPTY 가 마감 안에 닫히지 않았다");
            assert_eq!(
                count(&input, CURSOR_HOME_REPORT),
                1,
                "응답은 한 번만 보낸다"
            );
        }

        /// worktree 삭제 시나리오: 셸에서 띄운 자손 프로세스가 cwd 를 잡고 있어도 종료 직후 디렉터리를 지울 수 있어야 한다
        #[test]
        fn kill_releases_cwd_held_by_grandchild() {
            let dir = std::env::temp_dir().join(format!("minmo-pty-test-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let mut pty = spawn_cmd_pty(cmd_exe(Some(&dir)));
            answer_cursor_query_and_wait_shell(&mut pty);
            pty.proc
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

        /// 셸에서 손자를 띄우고 중간 부모(powershell)는 바로 끝내 부모 체인이 끊긴 고아를 만든다. 그 pid 를 돌려준다
        fn start_orphan(pty: &mut Pty) -> u32 {
            pty.proc
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
            pid
        }

        /// 프로세스가 곧 끝나는지 본다 — TerminateJobObject 도 종료를 시작만 하므로 잠시 기다린다. 남으면 정리한다
        fn gone_soon(pid: u32) -> bool {
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
            gone
        }

        /// 패널 닫기(Ctrl+W) 시나리오: 에이전트처럼 중간 부모가 먼저 끝나 부모 체인이 끊긴 자손도 함께 끝나야 한다.
        /// taskkill /T 는 이런 고아를 찾지 못하므로 Job Object 가 없으면 실패한다
        #[test]
        fn kill_terminates_orphaned_descendant() {
            let mut pty = spawn_cmd_pty(cmd_exe(None));
            answer_cursor_query_and_wait_shell(&mut pty);
            let pid = start_orphan(&mut pty);
            let (closed, _) = kill_with_timeout(pty);
            assert!(
                gone_soon(pid),
                "PTY 종료 후에도 고아 자손(pid {pid})이 살아 있다"
            );
            assert_eq!(closed, 1, "ConPTY 가 마감 안에 닫히지 않았다");
        }

        /// EC-09: 셸이 먼저 끝난 뒤(트리 종료는 건너뜀)에도 남은 자손은 Job 이 끝낸다
        #[test]
        fn kill_after_the_shell_exited_still_ends_descendants_through_the_job() {
            let mut pty = spawn_cmd_pty(cmd_exe(None));
            answer_cursor_query_and_wait_shell(&mut pty);
            let pid = start_orphan(&mut pty);
            pty.proc.write_input(b"exit\r").unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !matches!(pty.proc.child.try_wait(), Ok(Some(_))) {
                assert!(Instant::now() < deadline, "셸이 10초 안에 끝나지 않았다");
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(pid_alive(pid), "셸이 끝났을 때 자손이 이미 없다(검사 전제)");
            // Job 을 하나 더 쥐어 닫기(KILL_ON_JOB_CLOSE)로 끝나는 것과 가린다 — 끝내기(TerminateJobObject)만 본다
            let held = pty.proc.job.clone();
            let (closed, _) = kill_with_timeout(pty);
            let gone = gone_soon(pid);
            drop(held);
            assert!(
                gone,
                "셸이 먼저 끝난 뒤 남은 자손(pid {pid})을 끝내지 못했다"
            );
            assert_eq!(closed, 1, "ConPTY 가 마감 안에 닫히지 않았다");
        }

        // ── #100 앱이 끝날 때의 ConPTY 호스트 ─────────────────────────────

        /// 앱 종료(RunEvent::Exit): 남은 터미널을 모두 끝내고 ConPTY 가 닫힐 때까지 기다린 뒤 돌아온다
        #[test]
        fn close_all_closes_every_terminal_before_returning() {
            let state = PtyState::default();
            for _ in 0..2 {
                spawn_session(
                    &state.hub,
                    SpawnReq {
                        key: None,
                        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                        cols: 80,
                        rows: ROWS,
                        remote: None,
                    },
                )
                .unwrap();
            }
            assert_eq!(close_all(&state), 2, "마감 안에 모든 ConPTY 가 닫혀야 한다");
            assert!(state.hub.sessions.lock().unwrap().is_empty());
        }

        /// console_host_ends_when_the_app_is_killed 가 띄우는 도우미 — 앱처럼 PTY 를 열고, 이 프로세스의 ConPTY 호스트 pid 를
        /// 알린 뒤 부모가 강제로 끝낼 때까지 기다린다
        #[test]
        #[ignore = "console_host_ends_when_the_app_is_killed 가 띄우는 도우미"]
        fn console_host_helper() {
            let opened = open_proc(cmd_exe(None), 80, ROWS).unwrap();
            for pid in console_hosts() {
                println!("host={pid}=end");
            }
            std::thread::sleep(Duration::from_secs(30));
            // 부모가 끝내지 못했어도 닫지 않고 끝난다 — 시작 질의에 답하지 않은 ConPTY 는 닫기가 멈출 수 있다
            std::mem::forget(opened);
        }

        /// 앱이 ConPTY 를 닫지 못하고 끝나도(충돌·강제 종료·업데이트 설치) 호스트가 남지 않는다 —
        /// 일부 OpenConsole 은 부모가 닫지 않고 끝나면 끊긴 파이프에서 CPU 한 코어를 계속 쓴다
        #[test]
        fn console_host_ends_when_the_app_is_killed() {
            use std::io::{BufRead, BufReader};
            use std::process::{Command, Stdio};
            let mut helper = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "commands::pty::tests::conpty::console_host_helper",
                    "--ignored",
                    "--nocapture",
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let stdout = helper.stdout.take().unwrap();
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let pid = line
                        .strip_prefix("host=")
                        .and_then(|s| s.strip_suffix("=end"));
                    if let Some(pid) = pid.and_then(|s| s.parse::<u32>().ok()) {
                        let _ = tx.send(pid);
                    }
                }
            });
            let host = rx.recv_timeout(Duration::from_secs(15));
            // 충돌처럼 정리 없이 끝낸다(TerminateProcess)
            let _ = helper.kill();
            let _ = helper.wait();
            let host = host.expect("도우미가 ConPTY 호스트 pid 를 알리지 못했다");
            assert!(
                gone_soon(host),
                "앱이 강제로 끝난 뒤에도 ConPTY 호스트(pid {host})가 남았다"
            );
        }

        // ── #89 재접속의 ConPTY 전제(U3 관문) ─────────────────────────────

        /// 관측 출력을 읽을 수 있게 — 제어 문자를 이스케이프로
        fn show(text: &str) -> String {
            text.chars()
                .map(|c| match c {
                    '\x1b' => "\\e".to_string(),
                    '\x07' => "\\a".to_string(),
                    '\r' => "\\r".to_string(),
                    '\n' => "\\n".to_string(),
                    c if c.is_control() => format!("\\x{:02x}", c as u32),
                    c => c.to_string(),
                })
                .collect()
        }

        /// 명령을 PTY 로 돌려 시작 질의에 reply 로 답하고, done 이 나온 뒤 잠시 더 받은 출력(질의 뒤)을 돌려준다.
        /// 제목은 다음 화면 갱신에 실려 올 수 있어 끝 표시 뒤에도 조금 기다린다
        fn probe(cmd: CommandBuilder, reply: &[u8], done: &str) -> String {
            let mut pty = spawn_cmd_pty(cmd);
            wait_output(&pty.output, b"\x1b[6n", "커서 위치 질의(ESC[6n)");
            pty.proc.write_input(reply).unwrap();
            // powershell 이 느린 PC(시작만 3초 넘음)에서도 끝 표시를 기다리도록 넉넉히 둔다 — 정말 멈추면 여기서 드러난다
            let deadline = Instant::now() + Duration::from_secs(60);
            let mut out = Vec::new();
            while !String::from_utf8_lossy(&out).contains(done) {
                match pty
                    .output
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                {
                    Ok(o) => out = o,
                    Err(_) => {
                        let seen = show(&String::from_utf8_lossy(&out));
                        let _ = kill_with_timeout(pty);
                        panic!("{done} 을(를) 60초 안에 받지 못했다. 출력: {seen}");
                    }
                }
            }
            let settle = Instant::now() + Duration::from_millis(500);
            while let Ok(o) = pty
                .output
                .recv_timeout(settle.saturating_duration_since(Instant::now()))
            {
                out = o;
            }
            let _ = kill_with_timeout(pty);
            let text = String::from_utf8_lossy(&out).into_owned();
            let at = text
                .find(CURSOR_QUERY)
                .map_or(0, |i| i + CURSOR_QUERY.len());
            text[at..].to_string()
        }

        fn powershell(script: &str) -> CommandBuilder {
            let mut cmd = CommandBuilder::new("powershell.exe");
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
            cmd
        }

        /// 원격의 표시처럼 창 제목(OSC 2)을 VT 로 쓰는 함수 T — ssh.exe 가 원격 출력을 콘솔에 쓰는 것과 같다.
        /// 표시 글자는 실행 중에 이어 붙여 명령줄·창 제목에 그대로 나오지 않게 한다
        const TITLE_FN: &str =
            "$e=[char]27; $b=[char]7; function T($t) { [Console]::Write($e+']2;'+$t+$b) };";
        const DONE: &str = "Write-Output ('probe-'+'done')";

        /// 앱의 MarkerFilter 로 표시를 찾는다 — 찾으면 표시 뒤의 출력
        fn after_marker(out: &str) -> Option<String> {
            match MarkerFilter::new(false).filter(out, false) {
                (_, Some((Signal::Marker, rest))) => Some(rest),
                _ => None,
            }
        }

        /// 관문 ①: 원격이 쓴 창 제목 표시(OSC 2 minmo-link)가 ConPTY 를 지나 출력에 나온다
        #[test]
        fn conpty_passes_the_link_marker_title_to_the_output() {
            let script = format!("{TITLE_FN} T('minmo-'+'link'); {DONE}");
            let out = probe(powershell(&script), CURSOR_HOME_REPORT, "probe-done");
            eprintln!("관문 ① 관측: {}", show(&out));
            assert!(
                after_marker(&out).is_some(),
                "표시 제목이 출력에 없다: {}",
                show(&out)
            );
        }

        /// 관문 ②: 표시 뒤 0.2초 기다렸다 다른 제목(tmux·프롬프트)을 써도 표시가 남는다 —
        /// ConPTY 는 한 번의 화면 갱신에 마지막 제목만 보내므로 원격 명령이 표시 뒤에 잠깐 기다린다
        #[test]
        fn conpty_keeps_the_marker_when_the_next_title_comes_after_the_wait() {
            let script = format!(
                "{TITLE_FN} T('minmo-'+'link'); Start-Sleep -Milliseconds 200; T('other-'+'title'); {DONE}"
            );
            let out = probe(powershell(&script), CURSOR_HOME_REPORT, "probe-done");
            eprintln!("관문 ② 관측(0.2초 대기): {}", show(&out));
            let rest = after_marker(&out)
                .unwrap_or_else(|| panic!("표시가 다음 제목에 덮였다: {}", show(&out)));
            // 다음 제목도 실제로 왔어야 이 검사가 뜻이 있다
            assert!(
                rest.contains("other-title"),
                "다음 제목이 오지 않았다: {}",
                show(&out)
            );
        }

        /// 관찰용(단언 없음): 기다리지 않고 바로 다른 제목을 쓰면 표시가 남는가 — 원격 명령에 대기를 둔 이유
        #[test]
        #[ignore = "관찰용 — cargo test conpty_marker_without -- --ignored --nocapture"]
        fn conpty_marker_without_the_wait_is_only_observed() {
            let script = format!("{TITLE_FN} T('minmo-'+'link'); T('other-'+'title'); {DONE}");
            let out = probe(powershell(&script), CURSOR_HOME_REPORT, "probe-done");
            let kept = if after_marker(&out).is_some() {
                "남음"
            } else {
                "덮임"
            };
            eprintln!("관찰(대기 없음): 표시 {kept} — {}", show(&out));
        }

        /// 관문 ③: 시작 질의에 맨 아래 행(CPR {rows};1)으로 답한 뒤 화면보다 많은 줄을 내도 화면을 지우거나 처음부터 다시
        /// 그리지 않고 줄바꿈으로만 스크롤한다 — 재접속 준비 시퀀스가 커서를 둔 맨 아래 행과 ConPTY 의 커서가 맞는다
        #[test]
        fn conpty_scrolls_from_the_bottom_row_without_repainting() {
            let lines = ROWS * 2;
            let script =
                format!("1..{lines} | ForEach-Object {{ 'minmo-row-' + $_ + '-end' }}; {DONE}");
            let out = probe(
                powershell(&script),
                cpr_reply(ROWS).as_bytes(),
                "probe-done",
            );
            eprintln!("관문 ③ 관측: {}", show(&out));
            for bad in ["\x1b[H", "\x1b[1;1H", "\x1b[2J"] {
                assert!(!out.contains(bad), "{} 가 있다: {}", show(bad), show(&out));
            }
            for i in 1..=lines {
                let line = format!("minmo-row-{i}-end");
                assert_eq!(
                    out.matches(&line).count(),
                    1,
                    "{line} 을(를) 다시 그렸다: {}",
                    show(&out)
                );
            }
        }
    }
}
