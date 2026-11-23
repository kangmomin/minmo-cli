// 재접속 감독 통합 테스트(#89) — Plan v6 "테스트 — Rust pty_reconnect.rs".
// 주입 Spawner 로 실제 자식 프로세스(ConPTY/pty)를 띄우고, 기록용 Sink 로 알림(pty-link·pty-data·pty-exit) 순서를 본다.
use super::*;
use crate::commands::pty::{
    find, kill_all_in, kill_and_close, resize, spawn_session, take_by_cwd, take_by_id, write,
    LinkView, Opened, PtyLinkEvent, RemotePty, Sink, SpawnReq, Spawner,
};
use crate::commands::pty_link::Timing;
use portable_pty::CommandBuilder;
use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Barrier, Condvar, Mutex};

// ── 기록용 Sink ───────────────────────────────────────────────

#[derive(Clone, Debug)]
enum Note {
    Data(String, String),
    Exit(String),
    Resized(String, u16, u16),
    Link(PtyLinkEvent),
}

#[derive(Default)]
struct Rec {
    notes: Mutex<Vec<(Instant, Note)>>,
    cv: Condvar,
}

impl Sink for Rec {
    fn data(&self, id: &str, data: String, _end: u64) {
        self.push(Note::Data(id.into(), data));
    }
    fn exit(&self, id: &str) {
        self.push(Note::Exit(id.into()));
    }
    fn resized(&self, id: &str, cols: u16, rows: u16, _by: Option<String>) {
        self.push(Note::Resized(id.into(), cols, rows));
    }
    fn link(&self, ev: PtyLinkEvent) {
        self.push(Note::Link(ev));
    }
}

type Notes = [(Instant, Note)];

fn links<'a>(notes: &'a Notes, id: &'a str) -> impl Iterator<Item = (Instant, &'a LinkView)> {
    notes.iter().filter_map(move |(t, n)| match n {
        Note::Link(e) if e.id == id => Some((*t, &e.link)),
        _ => None,
    })
}

/// 그 터미널의 상태 알림 (phase, attempt) 목록
fn phases(notes: &Notes, id: &str) -> Vec<(&'static str, u32)> {
    links(notes, id)
        .map(|(_, l)| (l.phase, l.attempt))
        .collect()
}

fn has(notes: &Notes, id: &str, phase: &str, attempt: u32) -> bool {
    links(notes, id).any(|(_, l)| l.phase == phase && l.attempt == attempt)
}

/// 그 상태 알림이 처음 온 시각
fn at(notes: &Notes, id: &str, phase: &str, attempt: u32) -> Instant {
    links(notes, id)
        .find(|(_, l)| l.phase == phase && l.attempt == attempt)
        .map(|(t, _)| t)
        .unwrap_or_else(|| panic!("{phase}({attempt}) 알림이 없다"))
}

fn exits(notes: &Notes, id: &str) -> usize {
    notes
        .iter()
        .filter(|(_, n)| matches!(n, Note::Exit(i) if i == id))
        .count()
}

fn output(notes: &Notes, id: &str) -> String {
    notes
        .iter()
        .filter_map(|(_, n)| match n {
            Note::Data(i, d) if i == id => Some(d.as_str()),
            _ => None,
        })
        .collect()
}

fn dump(notes: &Notes) -> String {
    notes
        .iter()
        .map(|(_, n)| match n {
            Note::Link(e) => format!(
                "link {} {}({}) {:?}",
                e.id, e.link.phase, e.link.attempt, e.link.reason
            ),
            Note::Exit(id) => format!("exit {id}"),
            Note::Resized(id, c, r) => format!("resized {id} {c}x{r}"),
            Note::Data(id, d) => format!("data {id} {:?}", d.chars().take(80).collect::<String>()),
        })
        .collect::<Vec<_>>()
        .join("\n  ")
}

impl Rec {
    fn push(&self, n: Note) {
        self.notes.lock().unwrap().push((Instant::now(), n));
        self.cv.notify_all();
    }

    fn snapshot(&self) -> Vec<(Instant, Note)> {
        self.notes.lock().unwrap().clone()
    }

    /// pred 가 참이 될 때까지 기다린다(최대 secs 초)
    fn wait(&self, what: &str, secs: u64, pred: impl Fn(&Notes) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(secs);
        let mut notes = self.notes.lock().unwrap();
        while !pred(&notes) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                let seen = dump(&notes);
                drop(notes);
                panic!("{what} 을(를) {secs}초 안에 보지 못했다:\n  {seen}");
            }
            notes = self.cv.wait_timeout(notes, left).unwrap().0;
        }
    }

    fn wait_link(&self, id: &str, phase: &str, attempt: u32, secs: u64) {
        self.wait(&format!("{id} {phase}({attempt})"), secs, |n| {
            has(n, id, phase, attempt)
        });
    }
}

// ── 주입 Spawner ──────────────────────────────────────────────

enum Step {
    Run(CommandBuilder),
    /// 띄우지 못한다(호스트를 목록에서 뺌·ssh 없음 등)
    Fail,
    /// 띄운 뒤 gate 가 열릴 때까지 돌려주지 않는다 — 시도하는 동안의 일을 만든다
    Hold(CommandBuilder, mpsc::Receiver<()>),
}

struct Call {
    remote: RemotePty,
    cols: u16,
    rows: u16,
    pid: Option<u32>,
}

#[derive(Default)]
struct Script {
    steps: Mutex<VecDeque<Step>>,
    calls: Mutex<Vec<Call>>,
    called: Condvar,
}

impl Script {
    fn record(&self, r: &RemotePty, cols: u16, rows: u16, pid: Option<u32>) {
        self.calls.lock().unwrap().push(Call {
            remote: r.clone(),
            cols,
            rows,
            pid,
        });
        self.called.notify_all();
    }

    fn wait_calls(&self, n: usize) {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut calls = self.calls.lock().unwrap();
        while calls.len() < n {
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "Spawner 가 {n}번 불리지 않았다");
            calls = self.called.wait_timeout(calls, left).unwrap().0;
        }
    }

    fn pid(&self, i: usize) -> u32 {
        self.calls.lock().unwrap()[i].pid.expect("pid")
    }
}

fn spawner(script: Arc<Script>) -> Spawner {
    Box::new(move |r: &RemotePty, _cwd: &str, cols: u16, rows: u16| {
        // 정해 둔 단계가 없으면 아무것도 내지 않고 기다리는 프로세스
        let step = script
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Step::Run(sleep_cmd()));
        let open = |cmd| -> Result<Opened, String> {
            let o = pty::open_proc(cmd, cols, rows)?;
            script.record(r, cols, rows, o.proc.pid());
            Ok(o)
        };
        match step {
            Step::Run(cmd) => open(cmd),
            Step::Fail => {
                script.record(r, cols, rows, None);
                Err("ssh 를 찾을 수 없습니다".into())
            }
            Step::Hold(cmd, gate) => {
                let o = open(cmd)?;
                let _ = gate.recv_timeout(Duration::from_secs(20));
                Ok(o)
            }
        }
    })
}

// ── 테스트 명령(Windows: cmd·powershell, 그 밖: sh) ─────────────

fn command(args: &[&str]) -> CommandBuilder {
    let mut c = CommandBuilder::new(args[0]);
    c.args(&args[1..]);
    c
}

fn ps(script: &str) -> CommandBuilder {
    command(&[
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ])
}

fn sh(script: &str) -> CommandBuilder {
    command(&["sh", "-c", script])
}

fn exit_cmd(code: u32) -> CommandBuilder {
    if cfg!(windows) {
        command(&["cmd.exe", "/c", &format!("exit {code}")])
    } else {
        sh(&format!("exit {code}"))
    }
}

/// 잠시 뒤 255 로 끝난다 — 테스트가 그 사이에 준비할 틈
fn exit_255_later() -> CommandBuilder {
    if cfg!(windows) {
        ps("Start-Sleep -Milliseconds 1500; exit 255")
    } else {
        sh("sleep 1.5; exit 255")
    }
}

/// ssh 인증 실패처럼 출력하고 255
fn auth_fail_cmd() -> CommandBuilder {
    if cfg!(windows) {
        ps("Write-Output ('user@host: Permission denied '+'(publickey).'); exit 255")
    } else {
        sh("echo 'user@host: Permission denied (publickey).'; exit 255")
    }
}

/// 아무것도 내지 않고 오래 기다린다(멈춘 시도)
fn sleep_cmd() -> CommandBuilder {
    if cfg!(windows) {
        ps("Start-Sleep 60")
    } else {
        sh("sleep 60")
    }
}

/// 원격 명령처럼 연결 표시(창 제목 minmo-link)를 내고 0.2초 뒤 글을 낸다. 표시 글자는 실행 중에 이어 붙인다(명령줄·제목에 나오지 않게)
fn marker_cmd() -> CommandBuilder {
    if cfg!(windows) {
        ps(
            r"$e=[char]27; $b=[char]7; [Console]::Write($e+']2;minmo-'+'link'+$b); Start-Sleep -Milliseconds 200; Write-Output ('after-'+'marker'); Start-Sleep 60",
        )
    } else {
        sh(r"printf '\033]2;minmo-link\007'; sleep 0.2; echo after-marker; sleep 60")
    }
}

/// 0.1초마다 tick-N 을 낸다
fn ticker_cmd() -> CommandBuilder {
    if cfg!(windows) {
        ps("for ($i = 0; ; $i++) { Write-Output ('tick-' + $i); Start-Sleep -Milliseconds 100 }")
    } else {
        sh("i=0; while :; do echo tick-$i; i=$((i+1)); sleep 0.1; done")
    }
}

/// 입력을 받는 셸 — (보낼 명령, 셸이 펼친 결과)
fn shell_cmd() -> (CommandBuilder, &'static str, &'static str) {
    if cfg!(windows) {
        (
            command(&["cmd.exe"]),
            "echo minmo-%OS%\r",
            "minmo-Windows_NT",
        )
    } else {
        (command(&["sh", "-i"]), "echo minmo-$((40+2))\n", "minmo-42")
    }
}

fn pid_alive(pid: u32) -> bool {
    if cfg!(windows) {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    } else {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|s| s.success())
    }
}

/// 프로세스가 곧(5초 안에) 끝나는지
fn gone_soon(pid: u32) -> bool {
    (0..50).any(|_| {
        let alive = pid_alive(pid);
        if alive {
            std::thread::sleep(Duration::from_millis(100));
        }
        !alive
    })
}

// ── 환경 ─────────────────────────────────────────────────────

const MS: fn(u64) -> Duration = Duration::from_millis;
const LONG: Duration = Duration::from_secs(60);

fn timing(delays: [Duration; 5], deadline: Duration) -> Timing {
    Timing {
        delays,
        deadline,
        poll: MS(200),
        grace: MS(600),
    }
}

fn remote(session: Option<&str>, ephemeral: bool) -> RemotePty {
    RemotePty {
        host: "h".into(),
        session: session.map(Into::into),
        ephemeral,
    }
}

struct Env {
    hub: Arc<Hub>,
    rec: Arc<Rec>,
    script: Arc<Script>,
}

impl Env {
    fn new(t: Timing, steps: Vec<Step>) -> Self {
        let script = Arc::new(Script {
            steps: Mutex::new(steps.into()),
            ..Script::default()
        });
        let hub = Arc::new(Hub::new(spawner(script.clone()), t));
        let rec = Arc::new(Rec::default());
        let _ = hub.sink.set(rec.clone());
        let _ = hub.supervisor.set(supervise);
        Self { hub, rec, script }
    }

    fn open_with(&self, r: RemotePty, key: Option<&str>, cwd: &str) -> String {
        spawn_session(
            &self.hub,
            SpawnReq {
                key: key.map(Into::into),
                cwd: cwd.into(),
                cols: 80,
                rows: 24,
                remote: Some(r),
            },
        )
        .unwrap()
    }

    fn open(&self) -> String {
        self.open_with(remote(None, false), None, "/w/t")
    }

    fn notes(&self) -> Vec<(Instant, Note)> {
        self.rec.snapshot()
    }

    fn with<R>(&self, id: &str, f: impl FnOnce(&mut PtySession) -> R) -> R {
        let mut sessions = self.hub.sessions.lock().unwrap();
        f(sessions.get_mut(id).expect("세션"))
    }

    fn exists(&self, id: &str) -> bool {
        self.hub.sessions.lock().unwrap().contains_key(id)
    }

    /// 감독이 끝났는가 — 깨어남이 더 늘지 않는다
    fn supervisor_stopped(&self) -> bool {
        let before = self.hub.wakes.load(Ordering::SeqCst);
        std::thread::sleep(MS(600));
        self.hub.wakes.load(Ordering::SeqCst) == before
    }

    fn kill(&self, id: &str) {
        let s = take_by_id(&self.hub, id).unwrap();
        kill_and_close(s.into_iter().map(|s| s.proc).collect());
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let procs: Vec<_> = self
            .hub
            .sessions
            .lock()
            .map(|mut s| s.drain().map(|(_, v)| v.proc).collect())
            .unwrap_or_default();
        kill_and_close(procs);
    }
}

// ── 시도 순서·기다림 ──────────────────────────────────────────

// AC-01·AC-02·AC-07·AC-11: 처음 열 때 255(인증 아님)로 끝나면 pty-exit 없이 1/5 부터, 기다림 뒤 시도하고, 5번 모두 실패하면 실패.
// (Windows ConPTY 는 자식이 끝나도 닫기 전까지 출력을 닫지 않는다 — 끝난 ssh 는 감독의 주기 확인이 유예 뒤 판정한다)
#[test]
fn waiting_retries_in_order_after_each_delay_and_gives_up_after_five() {
    let delays = [MS(150), MS(250), MS(350), MS(150), MS(150)];
    let env = Env::new(
        timing(delays, MS(300)),
        (0..6).map(|_| Step::Run(exit_cmd(255))).collect(),
    );
    let id = env.open_with(remote(None, false), Some("pane-1"), "/w/t");
    env.rec.wait_link(&id, "failed", 5, 30);
    let notes = env.notes();
    let mut expected = Vec::new();
    for n in 1..=5 {
        expected.push(("waiting", n));
        expected.push(("connecting", n));
    }
    expected.push(("failed", 5));
    assert_eq!(phases(&notes, &id), expected, "{}", dump(&notes));
    for n in 1..=5u32 {
        let waited = at(&notes, &id, "connecting", n) - at(&notes, &id, "waiting", n);
        assert!(
            waited >= delays[n as usize - 1],
            "{n}번째 시도 전 {waited:?} 만 기다렸다"
        );
    }
    let failed = links(&notes, &id).last().unwrap().1.clone();
    assert_eq!((failed.reason, failed.max), (None, MAX_ATTEMPTS));
    let seqs: Vec<u64> = links(&notes, &id).map(|(_, l)| l.seq).collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "{seqs:?}");
    // 터미널 id 는 그대로, pty-exit 는 없다
    assert_eq!(exits(&notes, &id), 0);
    assert_eq!(find(&env.hub, "pane-1").unwrap().map(|f| f.id), Some(id));
}

// AC-08: 기다리는 중 [지금 재접속] → 남은 기다림 없이 바로 시도
#[test]
fn kick_skips_the_wait() {
    let env = Env::new(
        timing([LONG; 5], LONG),
        vec![Step::Run(exit_cmd(255)), Step::Run(sleep_cmd())],
    );
    let id = env.open();
    env.rec.wait_link(&id, "waiting", 1, 15);
    let kicked = Instant::now();
    kick(&env.hub, &id).unwrap();
    env.rec.wait_link(&id, "connecting", 1, 5);
    assert!(at(&env.notes(), &id, "connecting", 1) - kicked < Duration::from_secs(5));
    assert!(kick(&env.hub, "pty-none").is_err());
}

// AC-08 · D-15: 시도 중의 [지금 재접속] 은 무시하고, 동시에 여러 번 눌러도 시도는 하나
#[test]
fn concurrent_kicks_start_one_attempt_and_kicks_while_connecting_are_ignored() {
    let env = Env::new(
        timing([LONG; 5], LONG),
        vec![Step::Run(exit_cmd(255)), Step::Run(sleep_cmd())],
    );
    let id = env.open();
    env.rec.wait_link(&id, "waiting", 1, 15);
    let gate = Arc::new(Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let (hub, id, gate) = (env.hub.clone(), id.clone(), gate.clone());
            std::thread::spawn(move || {
                gate.wait();
                kick(&hub, &id).unwrap();
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    env.rec.wait_link(&id, "connecting", 1, 10);
    std::thread::sleep(MS(500));
    for _ in 0..3 {
        kick(&env.hub, &id).unwrap();
    }
    std::thread::sleep(MS(500));
    let notes = env.notes();
    assert_eq!(
        phases(&notes, &id),
        vec![("waiting", 1), ("connecting", 1)],
        "{}",
        dump(&notes)
    );
    assert_eq!(env.script.calls.lock().unwrap().len(), 2);
}

// AC-02: 기다리는 중 크기를 바꾸면 기록만 하고(pty-resized 는 알림) 다음 시도의 새 PTY 에 그 크기를 쓴다.
// 시도가 PTY 를 여는 동안 또 바뀌면 넣을 때 맞춘다
#[test]
fn resize_while_waiting_applies_to_the_next_attempt() {
    let (open, gate) = mpsc::channel();
    let env = Env::new(
        timing([LONG; 5], LONG),
        vec![Step::Run(exit_cmd(255)), Step::Hold(sleep_cmd(), gate)],
    );
    let id = env.open();
    env.rec.wait_link(&id, "waiting", 1, 15);
    resize(&env.hub, &id, 100, 30, None).unwrap();
    assert_eq!(env.with(&id, |s| (s.cols, s.rows)), (100, 30));
    kick(&env.hub, &id).unwrap();
    env.script.wait_calls(2);
    {
        let calls = env.script.calls.lock().unwrap();
        assert_eq!((calls[1].cols, calls[1].rows), (100, 30));
    }
    // 시도가 PTY 를 연 뒤 넣기 전(아직 기다림)에 또 바뀐다
    resize(&env.hub, &id, 120, 40, None).unwrap();
    open.send(()).unwrap();
    env.rec.wait_link(&id, "connecting", 1, 10);
    assert_eq!(env.with(&id, |s| s.proc.size()), Some((120, 40)));
    let notes = env.notes();
    let resized: Vec<_> = notes
        .iter()
        .filter_map(|(_, n)| match n {
            Note::Resized(i, c, r) if *i == id => Some((*c, *r)),
            _ => None,
        })
        .collect();
    assert_eq!(resized, vec![(100, 30), (120, 40)]);
}

// ── 제거 → pty-exit 정확히 한 번 ──────────────────────────────

fn removing_while_waiting(remove: impl FnOnce(&Env, &str)) {
    let env = Env::new(timing([LONG; 5], LONG), vec![Step::Run(exit_cmd(255))]);
    let id = env.open_with(remote(None, false), None, "/w/rm");
    env.rec.wait_link(&id, "waiting", 1, 15);
    remove(&env, &id);
    env.rec.wait("pty-exit", 5, |n| exits(n, &id) >= 1);
    assert!(env.supervisor_stopped(), "감독이 끝나지 않았다");
    assert_eq!(exits(&env.notes(), &id), 1);
    assert!(!env.exists(&id));
}

// EC-03: 재접속을 기다리는 중 패널을 닫으면(pty_kill) 감독이 끝나고 pty-exit 는 한 번
#[test]
fn kill_by_id_while_waiting_ends_the_supervisor_with_one_exit() {
    removing_while_waiting(|env, id| env.kill(id));
}

// EC-08: 앱 종료·새로 고침(kill_all)도 감독을 끝내고 pty-exit 는 한 번
#[test]
fn kill_all_while_waiting_ends_the_supervisor_with_one_exit() {
    removing_while_waiting(|env, _| kill_all_in(&env.hub));
}

// EC-04: worktree 삭제(pty_kill_by_cwd)도 감독을 끝내고 pty-exit 는 한 번
#[test]
fn kill_by_cwd_while_waiting_ends_the_supervisor_with_one_exit() {
    removing_while_waiting(|env, _| {
        let s = take_by_cwd(&env.hub, "/w/rm", Some("h")).unwrap();
        assert_eq!(s.len(), 1);
        kill_and_close(s.into_iter().map(|s| s.proc).collect());
    });
}

// 연결된 동안 패널을 닫아도 pty-exit 는 한 번(리더는 내지 않는다)
#[test]
fn removing_while_live_emits_one_exit() {
    let env = Env::new(timing([LONG; 5], LONG), vec![Step::Run(marker_cmd())]);
    let id = env.open();
    env.rec.wait("표시 뒤 출력", 20, |n| {
        output(n, &id).contains("after-marker")
    });
    env.kill(&id);
    env.rec.wait("pty-exit", 5, |n| exits(n, &id) >= 1);
    assert!(env.supervisor_stopped());
    let notes = env.notes();
    assert_eq!(exits(&notes, &id), 1);
    // 첫 세대의 표시는 연결 기록만 — 상태 알림은 없다
    assert!(phases(&notes, &id).is_empty(), "{}", dump(&notes));
}

// EC-03: 시도가 새 ssh 를 여는 동안 패널을 닫으면 새 프로세스를 버리고(끝낸다) pty-exit 는 한 번
#[test]
fn removing_during_an_attempt_discards_the_new_process() {
    let (open, gate) = mpsc::channel();
    let env = Env::new(
        timing([LONG; 5], LONG),
        vec![Step::Run(exit_cmd(255)), Step::Hold(sleep_cmd(), gate)],
    );
    let id = env.open();
    env.rec.wait_link(&id, "waiting", 1, 15);
    kick(&env.hub, &id).unwrap();
    env.script.wait_calls(2);
    let pid = env.script.pid(1);
    env.kill(&id);
    open.send(()).unwrap();
    env.rec.wait("pty-exit", 10, |n| exits(n, &id) >= 1);
    assert!(env.supervisor_stopped());
    let notes = env.notes();
    assert_eq!(exits(&notes, &id), 1);
    assert!(!has(&notes, &id, "connecting", 1), "{}", dump(&notes));
    assert!(gone_soon(pid), "버린 시도의 프로세스(pid {pid})가 남았다");
}

// 감독이 (통로가 닫히기 전에) 세션이 없어진 것을 먼저 봐도 pty-exit 는 한 번
#[test]
fn supervisor_that_finds_the_session_gone_emits_one_exit() {
    let env = Env::new(timing([LONG; 5], LONG), vec![Step::Run(marker_cmd())]);
    let id = env.open();
    env.rec.wait("표시 뒤 출력", 20, |n| {
        output(n, &id).contains("after-marker")
    });
    // 통로(tx)를 쥔 채 목록에서만 뺀다 — 감독은 주기 확인에서 세션이 없음을 본다
    let held = env.hub.sessions.lock().unwrap().remove(&id).unwrap();
    env.rec.wait("pty-exit", 5, |n| exits(n, &id) >= 1);
    assert!(env.supervisor_stopped());
    drop(held.tx);
    std::thread::sleep(MS(300));
    assert_eq!(exits(&env.notes(), &id), 1);
    kill_and_close(vec![held.proc]);
}

// EC-01 · AC-07: 처음 열 때 255 + 인증 실패 → 시도 없이 바로 실패. 실패 중에 닫으면 2초 안에 pty-exit 한 번
#[test]
fn auth_failure_fails_at_once_and_removing_while_failed_exits_within_two_seconds() {
    let env = Env::new(Timing::default(), vec![Step::Run(auth_fail_cmd())]);
    let id = env.open();
    env.rec.wait_link(&id, "failed", 0, 20);
    let notes = env.notes();
    assert_eq!(phases(&notes, &id), vec![("failed", 0)], "{}", dump(&notes));
    assert_eq!(links(&notes, &id).last().unwrap().1.reason, Some("auth"));
    assert_eq!(env.script.calls.lock().unwrap().len(), 1, "시도하지 않는다");
    let removed = Instant::now();
    env.kill(&id);
    env.rec.wait("pty-exit", 2, |n| exits(n, &id) >= 1);
    assert!(removed.elapsed() < Duration::from_secs(2));
    assert!(env.supervisor_stopped());
    assert_eq!(exits(&env.notes(), &id), 1);
}

// ── 마감·유예·EOF 없는 종료 ───────────────────────────────────

// AC-02: 표시도 보이는 출력도 없이 멈춘 시도는 마감에 끝내고(프로세스까지) 다음 시도로 넘어간다 — 그 시도가 표시를 내면 연결됨
#[test]
fn a_stuck_attempt_is_killed_at_the_deadline_and_the_next_attempt_follows() {
    let deadline = MS(1500);
    let env = Env::new(
        timing([MS(100); 5], deadline),
        vec![
            Step::Run(exit_cmd(255)),
            Step::Run(sleep_cmd()),
            Step::Run(marker_cmd()),
        ],
    );
    let id = env.open();
    env.rec.wait_link(&id, "connected", 0, 30);
    let notes = env.notes();
    assert_eq!(
        phases(&notes, &id),
        vec![
            ("waiting", 1),
            ("connecting", 1),
            ("waiting", 2),
            ("connecting", 2),
            ("connected", 0)
        ],
        "{}",
        dump(&notes)
    );
    assert!(at(&notes, &id, "waiting", 2) - at(&notes, &id, "connecting", 1) >= deadline);
    let stuck = env.script.pid(1);
    assert!(
        gone_soon(stuck),
        "마감에 끝낸 시도의 프로세스(pid {stuck})가 남았다"
    );
}

// AC-02: 마감에 끝낸 시도의 Eof 가 오지 않아도 유예 뒤 다음 기다림으로 넘어가고(갇히지 않는다),
// 유예 뒤 늦게 온 그 세대의 Eof 는 무시한다(시도 횟수 유지)
#[test]
fn no_eof_after_the_deadline_moves_on_after_the_grace_and_a_late_eof_is_ignored() {
    let deadline = MS(1000);
    let env = Env::new(
        timing([MS(100), LONG, LONG, LONG, LONG], deadline),
        vec![Step::Run(exit_cmd(255)), Step::Run(sleep_cmd())],
    );
    let id = env.open();
    env.rec.wait_link(&id, "connecting", 1, 15);
    // 리더의 Eof 가 감독에게 가지 못하게 통로를 빼 둔다(감독은 통로가 닫힌 것으로 보지 않는다)
    let (tx, gen) = env.with(&id, |s| (s.tx.take().unwrap(), s.link.gen));
    env.rec.wait_link(&id, "waiting", 2, 15);
    let notes = env.notes();
    let waited = at(&notes, &id, "waiting", 2) - at(&notes, &id, "connecting", 1);
    assert!(
        waited >= deadline + MS(600),
        "유예 전에 넘어갔다: {waited:?}"
    );
    // 유예 뒤에는 세대를 올린다 — 옛 리더의 늦은 출력·Eof 는 옛 세대로 버려진다
    assert!(env.with(&id, |s| s.link.gen) > gen);
    tx.send(Ev::Eof { gen }).unwrap();
    std::thread::sleep(MS(500));
    let notes = env.notes();
    assert_eq!(
        phases(&notes, &id),
        vec![("waiting", 1), ("connecting", 1), ("waiting", 2)],
        "{}",
        dump(&notes)
    );
    assert_eq!(env.with(&id, |s| s.link.attempt), 2);
    assert_eq!(exits(&notes, &id), 0);
    drop(tx);
    env.rec.wait("pty-exit", 5, |n| exits(n, &id) >= 1);
}

// AC-01: 연결된 동안 ssh 가 끝났는데 EOF 가 오지 않으면(자손이 PTY 를 쥔 경우) 유예 뒤 종료 코드로 판정한다 — 바쁜 대기 없이
#[test]
fn a_live_exit_without_eof_is_classified_after_the_grace_without_busy_waiting() {
    let env = Env::new(timing([LONG; 5], LONG), vec![Step::Run(exit_255_later())]);
    let id = env.open();
    let tx = env.with(&id, |s| s.tx.take().unwrap());
    let started = Instant::now();
    env.rec.wait_link(&id, "waiting", 1, 20);
    let elapsed = started.elapsed();
    let wakes = env.hub.wakes.load(Ordering::SeqCst);
    // 0.2초 주기 + 유예 — 바쁜 대기면 수천 번이다
    let bound = elapsed.as_millis() as u64 / 200 + 20;
    assert!(wakes < bound, "{elapsed:?} 동안 {wakes}번 깨어났다");
    assert_eq!(env.with(&id, |s| s.link.gen), 1, "세대를 올린다");
    drop(tx);
}

// AC-02: 시도 중 ssh 가 끝났는데 EOF 가 오지 않아도(통로를 빼 Eof 도 막음) 주기 확인으로 유예 뒤 판정한다(갇히지 않는다)
#[test]
fn a_connecting_exit_without_eof_is_classified_after_the_grace() {
    let env = Env::new(
        timing([MS(800), LONG, LONG, LONG, LONG], MS(2000)),
        vec![Step::Run(exit_cmd(255)), Step::Run(exit_cmd(255))],
    );
    let id = env.open();
    env.rec.wait_link(&id, "waiting", 1, 15);
    let tx = env.with(&id, |s| s.tx.take().unwrap());
    env.rec.wait_link(&id, "waiting", 2, 20);
    let notes = env.notes();
    assert_eq!(
        phases(&notes, &id),
        vec![("waiting", 1), ("connecting", 1), ("waiting", 2)],
        "{}",
        dump(&notes)
    );
    let wakes = env.hub.wakes.load(Ordering::SeqCst);
    assert!(wakes < 60, "{wakes}번 깨어났다");
    drop(tx);
}

// AC-02: 빨리 끝난 시도(연결 거부 등)는 출력이 닫히지 않아도 마감까지 기다리지 않고 주기 확인 + 유예 안에 다음 기다림으로 넘어간다
#[test]
fn a_quickly_failing_attempt_moves_on_long_before_the_deadline() {
    let deadline = Duration::from_secs(60);
    let env = Env::new(
        timing([MS(100), LONG, LONG, LONG, LONG], deadline),
        vec![Step::Run(exit_cmd(255)), Step::Run(exit_cmd(255))],
    );
    let id = env.open();
    env.rec.wait_link(&id, "waiting", 2, 20);
    let notes = env.notes();
    assert_eq!(
        phases(&notes, &id),
        vec![("waiting", 1), ("connecting", 1), ("waiting", 2)],
        "{}",
        dump(&notes)
    );
    // 주기 0.2초 + 유예 0.6초 — 여유를 두어도 마감(60초)보다 훨씬 이르다
    let took = at(&notes, &id, "waiting", 2) - at(&notes, &id, "connecting", 1);
    assert!(took < Duration::from_secs(5), "{took:?} 걸렸다");
    assert_eq!(exits(&notes, &id), 0);
}

// AC-02: 무시한 이벤트(옛 세대·기다림 중의 Eof)로 깨어나도 기다림이 늘어나지 않는다
#[test]
fn ignored_events_do_not_stretch_the_wait() {
    let delay = MS(1500);
    let env = Env::new(
        timing([delay, LONG, LONG, LONG, LONG], LONG),
        vec![Step::Run(exit_cmd(255)), Step::Run(sleep_cmd())],
    );
    let id = env.open();
    env.rec.wait_link(&id, "waiting", 1, 15);
    let (tx, gen) = env.with(&id, |s| (s.tx.clone().unwrap(), s.link.gen));
    let entered = at(&env.notes(), &id, "waiting", 1);
    while entered.elapsed() < MS(1200) {
        tx.send(Ev::Eof { gen }).unwrap();
        tx.send(Ev::Eof { gen: gen + 7 }).unwrap();
        std::thread::sleep(MS(100));
    }
    drop(tx);
    env.rec.wait_link(&id, "connecting", 1, 10);
    let waited = at(&env.notes(), &id, "connecting", 1) - entered;
    assert!(waited >= delay, "{waited:?}");
    assert!(waited < delay + MS(1000), "기다림이 늘었다: {waited:?}");
}

// ── 판정 ─────────────────────────────────────────────────────

// EC-07 · AC-07: 새 ssh 를 띄우지 못하면 바로 실패(spawn). [재접속] 은 1/5 부터 다시 시도한다
#[test]
fn a_spawn_error_fails_with_spawn_and_reconnect_starts_over() {
    let env = Env::new(
        timing([MS(100); 5], LONG),
        vec![Step::Run(exit_cmd(255)), Step::Fail],
    );
    let id = env.open();
    env.rec.wait_link(&id, "failed", 1, 15);
    let notes = env.notes();
    assert_eq!(
        phases(&notes, &id),
        vec![("waiting", 1), ("failed", 1)],
        "{}",
        dump(&notes)
    );
    assert_eq!(links(&notes, &id).last().unwrap().1.reason, Some("spawn"));
    kick(&env.hub, &id).unwrap();
    env.rec.wait_link(&id, "connecting", 1, 10);
    let last = env.notes();
    let (_, l) = links(&last, &id).last().unwrap();
    assert_eq!((l.phase, l.attempt, l.reason), ("connecting", 1, None));
}

// AC-10: 사용자가 끝내면(255 아님) 지금처럼 pty-exit 한 번, 재접속 없음, 세션은 치운다
#[test]
fn exit_0_ends_like_before() {
    let env = Env::new(timing([MS(100); 5], LONG), vec![Step::Run(exit_cmd(0))]);
    let id = env.open_with(remote(None, false), Some("pane-0"), "/w/t");
    env.rec.wait("pty-exit", 15, |n| exits(n, &id) >= 1);
    assert!(env.supervisor_stopped());
    let notes = env.notes();
    assert_eq!(exits(&notes, &id), 1);
    assert!(phases(&notes, &id).is_empty(), "{}", dump(&notes));
    assert!(!env.exists(&id));
    assert!(find(&env.hub, "pane-0").unwrap().is_none());
}

// ── 연결 신호·출력 ────────────────────────────────────────────

// AC-03 · AC-09: 시도 중 표시를 보면 연결됨 — 상태 알림이 주입 데이터보다 먼저, 구분 줄이 지난 출력(scrollback)에 남고
// 그 뒤에 새 셸의 출력이 온다. 표시는 화면으로 가지 않는다
#[test]
fn the_marker_goes_live_with_a_separator_in_the_scrollback_after_the_link_event() {
    let env = Env::new(
        timing([MS(100); 5], LONG),
        vec![Step::Run(exit_cmd(255)), Step::Run(marker_cmd())],
    );
    let id = env.open_with(remote(None, false), Some("pane-3"), "/w/t");
    env.rec.wait_link(&id, "connected", 0, 30);
    env.rec.wait("표시 뒤 출력", 20, |n| {
        output(n, &id).contains("after-marker")
    });
    let notes = env.notes();
    assert_eq!(
        phases(&notes, &id),
        vec![("waiting", 1), ("connecting", 1), ("connected", 0)],
        "{}",
        dump(&notes)
    );
    let line = "── 연결이 끊겨 다시 접속했습니다 (";
    let index = |pred: &dyn Fn(&Note) -> bool| {
        notes
            .iter()
            .position(|(_, n)| pred(n))
            .unwrap_or_else(|| panic!("{}", dump(&notes)))
    };
    let me: &str = &id;
    let is_link = |phase: &'static str| move |n: &Note| matches!(n, Note::Link(e) if e.id == me && e.link.phase == phase);
    let has_data = |text: &'static str| move |n: &Note| matches!(n, Note::Data(i, d) if i == me && d.contains(text));
    assert!(index(&is_link("connecting")) < index(&has_data("\x1b[!p")));
    assert!(index(&is_link("connected")) < index(&has_data(line)));
    assert!(index(&has_data(line)) < index(&has_data("after-marker")));
    let connected = links(&notes, &id).last().unwrap().1.clone();
    assert!(connected.at.is_some());
    let found = find(&env.hub, "pane-3").unwrap().unwrap();
    assert_eq!(found.link, connected);
    let sep = found
        .scrollback
        .find(line)
        .expect("구분 줄이 scrollback 에 없다");
    assert!(found.scrollback[sep..].contains("after-marker"));
    assert!(!found.scrollback.contains("minmo-link"));
    assert_eq!(exits(&notes, &id), 0);
}

// AC-02: 세대가 바뀐 뒤 옛 리더의 출력은 버린다(화면에도 scrollback 에도 가지 않는다)
#[test]
fn output_of_an_old_generation_is_dropped() {
    let env = Env::new(timing([LONG; 5], LONG), vec![Step::Run(ticker_cmd())]);
    let id = env.open_with(remote(None, false), Some("pane-4"), "/w/t");
    env.rec
        .wait("tick", 20, |n| output(n, &id).contains("tick-3"));
    env.with(&id, |s| s.advance_gen());
    let offset = |env: &Env| find(&env.hub, "pane-4").unwrap().unwrap().offset;
    let (before, total) = (output(&env.notes(), &id).len(), offset(&env));
    std::thread::sleep(MS(800));
    assert_eq!(output(&env.notes(), &id).len(), before);
    assert_eq!(offset(&env), total);
}

// EC-02: 연결되지 않은 동안(기다림·시도 중)의 입력은 버리고 Ok — 안전망 연결(마감 때 보이는 출력)부터 셸에 간다
#[test]
fn input_is_dropped_until_live_and_the_safety_net_keeps_the_attempt() {
    let (shell, typed, expanded) = shell_cmd();
    let env = Env::new(
        timing([MS(600), LONG, LONG, LONG, LONG], MS(3000)),
        vec![Step::Run(exit_cmd(255)), Step::Run(shell)],
    );
    let id = env.open();
    env.rec.wait_link(&id, "waiting", 1, 15);
    assert_eq!(write(&env.hub, &id, typed), Ok(()));
    env.rec.wait_link(&id, "connecting", 1, 10);
    assert_eq!(write(&env.hub, &id, typed), Ok(()));
    std::thread::sleep(MS(1000));
    assert!(!output(&env.notes(), &id).contains(expanded));
    // 표시는 없지만 셸이 보이는 출력을 냈다 — 마감에 안전망으로 연결됨(시도 횟수 유지, 구분 줄 없음)
    env.rec.wait("안전망 연결", 15, |n| {
        links(n, &id).any(|(_, l)| l.phase == "connected")
    });
    let notes = env.notes();
    let (_, live) = links(&notes, &id).last().unwrap();
    assert_eq!((live.phase, live.attempt), ("connected", 1));
    assert!(live.at.is_some());
    assert!(!output(&notes, &id).contains("다시 접속했습니다"));
    write(&env.hub, &id, typed).unwrap();
    env.rec
        .wait("셸 응답", 10, |n| output(n, &id).contains(expanded));
}

// AC-09 · AC-05: 다시 붙는 화면(find)은 기다림·실패 중인 원격 세션을 치우지 않고 지금 상태와 tmux 세션을 받는다
#[test]
fn find_keeps_waiting_and_failed_sessions_and_reports_link_and_tmux() {
    let env = Env::new(timing([LONG; 5], LONG), vec![Step::Run(exit_cmd(255))]);
    let id = env.open_with(remote(Some("minmo-0a1b-p2"), true), Some("pane-5"), "/w/t");
    env.rec.wait_link(&id, "waiting", 1, 15);
    for _ in 0..2 {
        let found = find(&env.hub, "pane-5").unwrap().expect("치우지 않는다");
        assert_eq!(found.id, id);
        assert_eq!(
            (found.link.phase, found.link.attempt, found.link.max),
            ("waiting", 1, MAX_ATTEMPTS)
        );
        let tmux = found.tmux.expect("tmux");
        assert_eq!(
            (tmux.session.as_str(), tmux.ephemeral),
            ("minmo-0a1b-p2", true)
        );
    }

    let env = Env::new(Timing::default(), vec![Step::Run(auth_fail_cmd())]);
    let id = env.open_with(remote(None, false), Some("pane-6"), "/w/t");
    env.rec.wait_link(&id, "failed", 0, 20);
    let found = find(&env.hub, "pane-6").unwrap().expect("치우지 않는다");
    assert_eq!(
        (found.link.phase, found.link.reason),
        ("failed", Some("auth"))
    );
    assert!(found.tmux.is_none());
}

// EC-06: 재접속은 처음 연 요청(호스트·tmux 세션·분할 여부)으로 다시 연다
#[test]
fn retries_with_the_remote_it_was_opened_with() {
    let env = Env::new(
        timing([MS(100); 5], LONG),
        vec![Step::Run(exit_cmd(255)), Step::Run(sleep_cmd())],
    );
    let r = RemotePty {
        host: "h1".into(),
        session: Some("minmo-9f".into()),
        ephemeral: true,
    };
    let id = env.open_with(r, None, "/w/t");
    env.rec.wait_link(&id, "connecting", 1, 15);
    let calls = env.script.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    for c in calls.iter() {
        assert_eq!(
            (
                c.remote.host.as_str(),
                c.remote.session.as_deref(),
                c.remote.ephemeral
            ),
            ("h1", Some("minmo-9f"), true)
        );
    }
}

// EC-10: 같이 끊긴 두 패널은 따로 재접속한다
#[test]
fn two_sessions_reconnect_independently() {
    let env = Env::new(
        timing([LONG; 5], LONG),
        vec![
            Step::Run(exit_cmd(255)),
            Step::Run(exit_cmd(255)),
            Step::Run(sleep_cmd()),
            Step::Run(sleep_cmd()),
        ],
    );
    let a = env.open();
    let b = env.open();
    env.rec.wait_link(&a, "waiting", 1, 15);
    env.rec.wait_link(&b, "waiting", 1, 15);
    kick(&env.hub, &a).unwrap();
    env.rec.wait_link(&a, "connecting", 1, 10);
    std::thread::sleep(MS(500));
    assert_eq!(phases(&env.notes(), &b), vec![("waiting", 1)]);
    kick(&env.hub, &b).unwrap();
    env.rec.wait_link(&b, "connecting", 1, 10);
    assert_eq!(
        phases(&env.notes(), &a),
        vec![("waiting", 1), ("connecting", 1)]
    );
}
