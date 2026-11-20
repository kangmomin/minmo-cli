// 원격 터미널 재접속(#89)의 순수 로직 — 스레드·시계 없이 상태 전이와 출력 거르기만 한다(시각은 인자로 받는다).
// TODO(#89 U1): Red 단계의 빈 스텁. 시그니처는 Plan v6 §1, 동작은 pty_link_tests.rs 가 정한다
#![allow(dead_code)] // TODO(#89 U3): pty.rs·pty_reconnect.rs 가 쓰기 시작하면 지운다

use std::collections::BTreeMap;
use std::time::Duration;

/// 자동 재접속 최대 횟수
pub(crate) const MAX_ATTEMPTS: u32 = 5;
/// 세대 꼬리(gen_tail)·visible 이 보는 출력의 끝 길이(바이트)
pub(crate) const TAIL_LIMIT: usize = 4096;

/// 기다림·시도 마감 — 테스트는 짧은 값을 넣는다
#[derive(Clone, Debug)]
pub(crate) struct Timing {
    /// n 번째 시도 전에 기다리는 시간(n = 1..=MAX_ATTEMPTS)
    pub delays: [Duration; MAX_ATTEMPTS as usize],
    /// 시도(Connecting)가 연결 표시 없이 이만큼 지나면 마감
    pub deadline: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        let s = Duration::from_secs;
        Self {
            delays: [s(2), s(4), s(8), s(16), s(30)],
            deadline: s(30),
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
        self.gen
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
    let _ = (link, ev_gen, now);
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
    let _ = (link, ev_gen, alive, gen_has_visible, now);
    false
}

/// 그 세대의 ssh 가 끝났다. code 는 종료 코드(모르면 None), gen_tail 은 그 세대의 연결 전 출력
pub(crate) fn on_exit(link: &mut Link, ev_gen: u64, code: Option<u32>, gen_tail: &str) -> Exit {
    let _ = (link, ev_gen, code, gen_tail);
    Exit::Ignored
}

/// [지금 재접속]·[재접속] — 바로 시도해야 하면 true
pub(crate) fn on_request(link: &mut Link) -> bool {
    let _ = link;
    false
}

/// 출력(끝 TAIL_LIMIT 바이트)에 화면에 보이는 글자가 있는가 — 제어 문자열·공백은 세지 않는다
pub(crate) fn visible(text: &str) -> bool {
    let _ = text;
    false
}

/// ssh::classify 에 넘기기 전에 세대 꼬리에서 제어 문자열을 뺀다
pub(crate) fn normalize_tail(tail: &str) -> String {
    let _ = tail;
    String::new()
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
        let _ = (self.tmux, &self.carry, text, strip_titles);
        (String::new(), None)
    }
}

/// 재접속한 새 ssh 의 출력 앞에 넣는 준비 시퀀스 — 끊기기 전 프로그램이 켜 둔 모드를 끄고 커서를 맨 아래 새 줄로
pub(crate) fn reattach_prelude(modes: &BTreeMap<u16, bool>, rows: u16, clear_title: bool) -> String {
    let _ = (modes, rows, clear_title);
    String::new()
}

/// 재접속 성공 때 출력에 넣는 구분 줄
pub(crate) fn separator(hhmm: &str) -> String {
    let _ = hhmm;
    String::new()
}

/// 새 ConPTY 의 시작 커서 위치 질의에 줄 답 — 준비 시퀀스가 커서를 맨 아래 행에 둔다
pub(crate) fn cpr_reply(rows: u16) -> String {
    let _ = rows;
    String::new()
}

#[cfg(test)]
#[path = "pty_link_tests.rs"]
mod tests;
