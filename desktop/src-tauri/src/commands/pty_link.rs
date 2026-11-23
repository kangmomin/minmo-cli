// 원격 터미널 재접속(#89)의 순수 로직 — 스레드·시계 없이 상태 전이와 출력 거르기만 한다(시각은 인자로 받는다).

use std::collections::BTreeMap;
use std::time::Duration;

use super::ssh;

/// 자동 재접속 최대 횟수
pub(crate) const MAX_ATTEMPTS: u32 = 5;
/// 세대 꼬리(gen_tail)·visible 이 보는 출력의 끝 길이(바이트)
pub(crate) const TAIL_LIMIT: usize = 4096;
/// ssh 자체가 실패했을 때의 종료 코드 — 원격 셸의 255 는 원격 명령이 254 로 바꿔 넘긴다(D-27)
const SSH_FAILED: u32 = 255;
/// 대체 화면을 켜는 DEC private mode — 전체 화면 프로그램(Claude Code 등)이 쓴다
pub(crate) const ALT_SCREEN_MODES: [u16; 3] = [47, 1047, 1049];
/// 재접속 때 끄는 입력 모드(마우스 보고·포커스 보고·괄호 붙여넣기). 끊긴 프로그램이 켠 채로 두면 새 셸에 보고가 글자로 들어간다
const INPUT_MODES: [u16; 11] = [
    9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004,
];
/// 동기화 출력(DEC 2026) — 프레임 도중에 끊긴 프로그램이 켠 채로 두면 화면이 새 셸의 출력을 그리지 않고 기다린다
const SYNC_OUTPUT: u16 = 2026;
/// 원격 명령이 맨 앞에 창 제목으로 내는 연결 표시
const MARKER: &str = "minmo-link";
/// tmux 제목 접두어 — pty.rs 의 TMUX_TITLE_FORMAT 과 짝이다
const TMUX_TITLE_PREFIX: &str = "minmo:";
/// 조각 경계에서 이어 볼 창 제목의 길이 상한 — 넘으면 신호가 아닌 출력으로 내보낸다
const TITLE_CARRY_LIMIT: usize = 1024;

/// 기다림·시도 마감 — 테스트는 짧은 값을 넣는다
#[derive(Clone, Debug)]
pub(crate) struct Timing {
    /// n 번째 시도 전에 기다리는 시간(n = 1..=MAX_ATTEMPTS)
    pub delays: [Duration; MAX_ATTEMPTS as usize],
    /// 시도(Connecting)가 연결 표시 없이 이만큼 지나면 마감
    pub deadline: Duration,
    /// 연결됨·실패 중에 세션이 남아 있는지(와 EOF 없이 끝난 ssh)를 보는 주기
    pub poll: Duration,
    /// 끝난(끝낸) ssh 의 Eof 를 기다리는 유예 — 지나면 감독이 대신 처리한다
    pub grace: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        let s = Duration::from_secs;
        Self {
            delays: [s(2), s(4), s(8), s(16), s(30)],
            deadline: s(30),
            poll: s(2),
            grace: s(3),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Phase {
    /// 연결됨(첫 세대·재접속 성공·안전망)
    #[default]
    Live,
    /// 다음 시도를 기다리는 중
    Waiting,
    /// 새 ssh 로 시도하는 중
    Connecting,
    /// 자동 재접속을 그만뒀다([재접속] 을 기다림)
    Failed,
}

/// 세션 하나의 연결 상태. 상태가 바뀔 때마다 seq 가 오른다
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Link {
    pub phase: Phase,
    /// 지금 세대 — 늦게 온 옛 세대의 Eof·표시를 가려낸다(PtySession.gen 은 이 값의 거울)
    pub gen: u64,
    /// 지금(또는 다음) 시도 번호 1..=MAX_ATTEMPTS, 연결되면 0
    pub attempt: u32,
    pub seq: u64,
    /// 이 세대에서 연결 신호(표시·tmux 제목)를 봤다
    pub connected: bool,
    /// 안전망(마감 때 보이는 출력)으로 된 Live
    pub provisional: bool,
    /// 이 세대의 시도를 마감으로 끝냈다
    pub timed_out: bool,
    /// 실패 원인: "auth" | "host_key" | "spawn"
    pub reason: Option<&'static str>,
    /// 다시 접속한 시각(HH:MM)
    pub at: Option<String>,
}

impl Link {
    /// 세대를 올린다 — 세대마다의 값(connected·timed_out)은 처음으로. 새 세대 번호를 돌려준다
    pub(crate) fn advance_gen(&mut self) -> u64 {
        self.gen += 1;
        self.connected = false;
        self.timed_out = false;
        self.provisional = false;
        self.gen
    }

    /// 지금 세대의 ssh 가 돈다(연결됨·시도 중) — Waiting·Failed 의 PTY 는 끝난 ssh 의 것이다
    pub(crate) fn running(&self) -> bool {
        matches!(self.phase, Phase::Live | Phase::Connecting)
    }

    /// 세대 이벤트(표시·마감·Eof)를 받을 때인가 — 연결됨·시도 중인 지금 세대만
    pub(crate) fn current(&self, ev_gen: u64) -> bool {
        self.running() && ev_gen == self.gen
    }

    fn wait_for(&mut self, attempt: u32) {
        self.phase = Phase::Waiting;
        self.attempt = attempt;
        self.reason = None;
        self.provisional = false;
        self.at = None;
        self.seq += 1;
    }

    fn fail(&mut self, reason: Option<&'static str>) {
        self.phase = Phase::Failed;
        self.reason = reason;
        self.provisional = false;
        self.at = None;
        self.seq += 1;
    }
}

/// 감독 스레드가 받는 이벤트
#[derive(Debug)]
pub(crate) enum Ev {
    /// 그 세대의 출력이 끝났다(ssh 종료)
    Eof { gen: u64 },
    /// [지금 재접속]·[재접속]
    Kick,
}

/// on_exit 의 판정
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Exit {
    /// 지금 세대의 일이 아니다(옛 세대·Waiting·Failed)
    Ignored,
    /// 지금처럼 끝낸다(pty-exit)
    End,
    /// 다음 시도를 기다린다(Waiting)
    Retry,
    /// 자동 재접속을 그만둔다(Failed)
    Fail,
}

/// 연결 신호(표시 `minmo-link` 또는 tmux 제목 `minmo:`)를 봤다 — 구분 줄 신호면 true
pub(crate) fn on_marker(link: &mut Link, ev_gen: u64, now: &str) -> bool {
    // 마감으로 끝내기로 한 세대는 곧 끝난다 — 늦은 표시로 살리지 않는다
    if !link.current(ev_gen) || link.timed_out {
        return false;
    }
    link.connected = true;
    if link.phase == Phase::Connecting {
        link.phase = Phase::Live;
        link.attempt = 0;
        link.at = Some(now.to_string());
        link.seq += 1;
        return true;
    }
    // 안전망 Live 의 진짜 표시: 커서 위치를 모르므로 구분 줄 없이 횟수만 처음으로
    if link.provisional {
        link.provisional = false;
        link.attempt = 0;
        link.seq += 1;
    }
    false
}

/// 시도 마감. 그 세대의 ssh 를 끝내야 하면 true
pub(crate) fn on_deadline(
    link: &mut Link,
    ev_gen: u64,
    alive: bool,
    gen_has_visible: bool,
    now: &str,
) -> bool {
    // 이미 끝난 ssh 는 곧 올 Eof 가 분류한다. 마감은 세대마다 한 번
    if link.phase != Phase::Connecting || ev_gen != link.gen || link.timed_out || !alive {
        return false;
    }
    if gen_has_visible {
        // 표시가 빠진 환경(ForceCommand 등)·프롬프트 인증 — 연결된 것으로 보되 시도 횟수는 그대로 둔다
        link.phase = Phase::Live;
        link.provisional = true;
        link.at = Some(now.to_string());
        link.seq += 1;
        return false;
    }
    link.timed_out = true;
    true
}

/// 그 세대의 ssh 가 끝났다. code 는 종료 코드(모르면 None), gen_tail 은 그 세대의 연결 전 출력
pub(crate) fn on_exit(link: &mut Link, ev_gen: u64, code: Option<u32>, gen_tail: &str) -> Exit {
    if !link.current(ev_gen) {
        return Exit::Ignored;
    }
    // 마감으로 끝낸 시도는 우리가 죽인 것이라 종료 코드·출력을 보지 않는다
    if !link.timed_out {
        if code != Some(SSH_FAILED) {
            return Exit::End;
        }
        // 연결 전의 255 만 원인을 본다 — 인증·호스트 키는 다시 해도 같으므로 바로 그만둔다(EC-01)
        if !link.connected {
            let kind = ssh::classify(&normalize_tail(gen_tail)).kind;
            if matches!(kind, "auth" | "host_key") {
                link.fail(Some(kind));
                return Exit::Fail;
            }
        }
    }
    let next = link.attempt + 1;
    if next > MAX_ATTEMPTS {
        link.fail(None);
        return Exit::Fail;
    }
    link.wait_for(next);
    Exit::Retry
}

/// 기다리던 시도를 시작한다(새 ssh 를 넣기 직전) — 새 세대 번호를 돌려준다
pub(crate) fn begin_attempt(link: &mut Link) -> u64 {
    link.phase = Phase::Connecting;
    link.reason = None;
    link.at = None;
    link.seq += 1;
    link.advance_gen()
}

/// 새 ssh 를 띄우지 못했다(호스트를 목록에서 뺌·ssh 없음·PTY 오류) — 다시 해도 같으므로 그만둔다(EC-07)
pub(crate) fn on_spawn_error(link: &mut Link) {
    link.fail(Some("spawn"));
}

/// [지금 재접속]·[재접속] — 바로 시도해야 하면 true
pub(crate) fn on_request(link: &mut Link) -> bool {
    match link.phase {
        Phase::Waiting => true,
        Phase::Failed => {
            link.wait_for(1);
            true
        }
        Phase::Live | Phase::Connecting => false,
    }
}

/// 출력(끝 TAIL_LIMIT 바이트)에 화면에 보이는 글자가 있는가 — 제어 문자열·공백은 세지 않는다
pub(crate) fn visible(text: &str) -> bool {
    strip_sequences(tail_of(text))
        .chars()
        .any(|c| !c.is_control() && !c.is_whitespace())
}

/// ssh::classify 에 넘기기 전에 세대 꼬리에서 제어 문자열을 뺀다
pub(crate) fn normalize_tail(tail: &str) -> String {
    strip_sequences(tail)
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\r' | '\n' | '\t'))
        .collect()
}

/// 끝 TAIL_LIMIT 바이트. 자를 때 걸린 앞 조각(제어 문자열의 중간일 수 있다)은 첫 제어 문자까지 버린다 —
/// 그 문자가 BEL 이면 잘린 OSC 의 끝이므로 함께 버린다
fn tail_of(text: &str) -> &str {
    if text.len() <= TAIL_LIMIT {
        return text;
    }
    let mut cut = text.len() - TAIL_LIMIT;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    let rest = &text[cut..];
    match rest.find(|c: char| c.is_ascii_control()) {
        Some(i) if rest.as_bytes()[i] == 0x07 => &rest[i + 1..],
        Some(i) => &rest[i..],
        None => "",
    }
}

/// 제어 문자열(CSI·OSC·DCS 등 문자열 시퀀스·ESC 시퀀스)을 내용째 뺀다. 끝나지 않은 시퀀스는 끝까지 뺀다
fn strip_sequences(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while let Some(off) = text[i..].find('\x1b') {
        out.push_str(&text[i..i + off]);
        i = sequence_end(b, i + off);
    }
    out.push_str(&text[i..]);
    out
}

/// at(ESC)에서 시작한 시퀀스의 다음 위치. 끝 바이트 자리에 다른 글자가 오면 거기서 멈춘다(UTF-8 글자 중간을 자르지 않게)
fn sequence_end(b: &[u8], at: usize) -> usize {
    let mut i = at + 1;
    let fin = |i: usize, range: std::ops::RangeInclusive<u8>| match b.get(i) {
        Some(c) if range.contains(c) => i + 1,
        _ => i,
    };
    match b.get(i) {
        // CSI: 매개변수·중간 바이트 뒤 끝 바이트 하나
        Some(b'[') => {
            i += 1;
            while b.get(i).is_some_and(|c| (0x20..=0x3f).contains(c)) {
                i += 1;
            }
            fin(i, 0x40..=0x7e)
        }
        // 문자열 시퀀스(OSC·DCS·SOS·PM·APC): BEL 또는 ST(ESC \) 까지
        Some(b']' | b'P' | b'X' | b'^' | b'_') => {
            i += 1;
            while let Some(&c) = b.get(i) {
                match c {
                    0x07 => return i + 1,
                    0x1b if b.get(i + 1) == Some(&b'\\') => return i + 2,
                    // ST 가 아닌 ESC 는 문자열을 끊고 새 시퀀스를 시작한다
                    0x1b => return i,
                    _ => i += 1,
                }
            }
            i
        }
        // ESC 시퀀스: 중간 바이트(`ESC ( B` 의 `(` 등) 뒤 끝 바이트 하나
        Some(_) => {
            while b.get(i).is_some_and(|c| (0x20..=0x2f).contains(c)) {
                i += 1;
            }
            fin(i, 0x30..=0x7e)
        }
        None => i,
    }
}

/// 연결 신호의 종류
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Signal {
    /// 원격 명령이 맨 앞에 내는 표시(창 제목 `minmo-link`) — 출력에서 뺀다
    Marker,
    /// tmux 제목(`minmo:` 접두어) — 출력에 남긴다
    Tmux,
}

/// 출력에서 연결 신호를 찾는다. 조각 경계에서 잘린 제목은 다음 조각과 이어 본다
pub(crate) struct MarkerFilter {
    tmux: bool,
    carry: String,
}

/// OSC(`ESC ]` 뒤)의 끝
enum OscEnd {
    /// 내용 길이와 종결자까지의 길이
    Done { content: usize, len: usize },
    /// 조각 안에서 끝나지 않았다
    Open,
    /// ST 가 아닌 ESC 로 끊겼다 — 그 ESC 의 위치
    Broken(usize),
}

fn osc_end(body: &str) -> OscEnd {
    let b = body.as_bytes();
    for (k, &c) in b.iter().enumerate() {
        match c {
            0x07 => {
                return OscEnd::Done {
                    content: k,
                    len: k + 1,
                }
            }
            0x1b => {
                return match b.get(k + 1) {
                    Some(b'\\') => OscEnd::Done {
                        content: k,
                        len: k + 2,
                    },
                    Some(_) => OscEnd::Broken(k),
                    None => OscEnd::Open,
                }
            }
            _ => {}
        }
    }
    OscEnd::Open
}

/// 창 제목 OSC(0·2)의 제목 부분
fn title_of(content: &str) -> Option<&str> {
    content
        .strip_prefix("0;")
        .or_else(|| content.strip_prefix("2;"))
}

impl MarkerFilter {
    /// tmux: tmux 세션이면 tmux 제목도 연결 신호로 본다
    pub(crate) fn new(tmux: bool) -> Self {
        Self {
            tmux,
            carry: String::new(),
        }
    }

    /// text 를 첫 신호 앞까지 걸러 돌려준다. 신호를 만나면 (신호, 아직 거르지 않은 나머지)도 돌려준다 —
    /// 호출자는 상태를 바꾼 뒤 나머지를 다시 넣는다. Tmux 신호의 제목은 앞부분 끝에 남긴다.
    /// strip_titles: 창 제목(OSC 0·2)을 모두 뺀다(재접속 시도 중 — ConPTY 의 ssh.exe 경로 제목)
    pub(crate) fn filter(
        &mut self,
        text: &str,
        strip_titles: bool,
    ) -> (String, Option<(Signal, String)>) {
        let buf = std::mem::take(&mut self.carry) + text;
        let mut head = String::new();
        // head 로 옮긴 곳까지
        let mut copied = 0;
        let mut i = 0;
        while let Some(off) = buf[i..].find('\x1b') {
            let at = i + off;
            let rest = &buf[at..];
            if rest.len() == 1 {
                // 조각이 ESC 로 끝났다 — 표시의 시작일 수 있다
                head.push_str(&buf[copied..at]);
                self.carry = rest.to_string();
                return (head, None);
            }
            let Some(body) = rest.strip_prefix("\x1b]") else {
                i = at + 1;
                continue;
            };
            match osc_end(body) {
                OscEnd::Done { content, len } => {
                    let end = at + 2 + len;
                    match title_of(&body[..content]) {
                        Some(MARKER) => {
                            head.push_str(&buf[copied..at]);
                            return (head, Some((Signal::Marker, buf[end..].to_string())));
                        }
                        Some(t) if self.tmux && t.starts_with(TMUX_TITLE_PREFIX) => {
                            head.push_str(&buf[copied..end]);
                            return (head, Some((Signal::Tmux, buf[end..].to_string())));
                        }
                        Some(_) if strip_titles => {
                            head.push_str(&buf[copied..at]);
                            copied = end;
                        }
                        _ => {}
                    }
                    i = end;
                }
                OscEnd::Broken(k) => i = at + 2 + k,
                OscEnd::Open => {
                    if rest.len() <= TITLE_CARRY_LIMIT && self.may_be_title(body, strip_titles) {
                        head.push_str(&buf[copied..at]);
                        self.carry = rest.to_string();
                        return (head, None);
                    }
                    // 신호도, 뺄 제목도 될 수 없다 — 끝까지 그대로 내보낸다
                    break;
                }
            }
        }
        // 뺀 제목이 없으면 head 는 비어 있다 — 조각마다 한 번 더 복사하지 않게 그대로 돌려준다
        if copied == 0 {
            return (buf, None);
        }
        head.push_str(&buf[copied..]);
        (head, None)
    }

    /// 끝나지 않은 OSC(body = `ESC ]` 뒤)가 신호나 뺄 제목이 될 수 있는가
    fn may_be_title(&self, body: &str, strip_titles: bool) -> bool {
        let body = body.strip_suffix('\x1b').unwrap_or(body);
        let title = match body.as_bytes() {
            [] | [b'0' | b'2'] => return true,
            [b'0' | b'2', b';', ..] => &body[2..],
            _ => return false,
        };
        strip_titles
            || MARKER.starts_with(title)
            || (self.tmux
                && (TMUX_TITLE_PREFIX.starts_with(title) || title.starts_with(TMUX_TITLE_PREFIX)))
    }
}

/// 재접속한 새 ssh 의 출력 앞에 넣는 준비 시퀀스 — 끊기기 전 프로그램이 켜 둔 모드를 끄고 커서를 맨 아래 새 줄로
pub(crate) fn reattach_prelude(
    modes: &BTreeMap<u16, bool>,
    rows: u16,
    clear_title: bool,
) -> String {
    let on = |m: &u16| modes.get(m) == Some(&true);
    let mut out = String::new();
    if ALT_SCREEN_MODES.iter().any(on) {
        out.push_str("\x1b[?1049l");
    }
    for m in INPUT_MODES.iter().chain([&SYNC_OUTPUT]).filter(|m| on(m)) {
        out.push_str(&format!("\x1b[?{m}l"));
    }
    // DECSTR(소프트 리셋) 뒤 커서 보임·커서 키·자동 줄바꿈을 명시한다 — Scrollback 은 시퀀스로만 모드를 기록하므로
    // 나중에 붙는 화면의 모드 복원도 맞게
    out.push_str("\x1b[!p\x1b[?25h\x1b[?1l\x1b[?7h\x1b[0 q");
    // tmux 는 다시 붙으면 제목을 다시 보내므로 지우지 않는다(에이전트 감지가 제목을 잃지 않게)
    if clear_title {
        out.push_str("\x1b]0;\x07");
    }
    // 새 ConPTY 는 이전 화면을 모른다 — 맨 아래 행에서 한 줄 내려 새 줄에서 시작한다(CPR 도 맨 아래 행으로 답한다)
    out.push_str(&format!("\x1b[{rows};1H\r\n"));
    out
}

/// 재접속 성공 때 출력에 넣는 구분 줄
pub(crate) fn separator(hhmm: &str) -> String {
    format!("\r── 연결이 끊겨 다시 접속했습니다 ({hhmm}) ──\r\n")
}

/// 새 ConPTY 의 시작 커서 위치 질의에 줄 답 — 준비 시퀀스가 커서를 맨 아래 행에 둔다
pub(crate) fn cpr_reply(rows: u16) -> String {
    format!("\x1b[{rows};1R")
}

#[cfg(test)]
#[path = "pty_link_tests.rs"]
mod tests;
