// pty_link 의 순수 로직 테스트(#89) — Plan v6 "테스트 — Rust pty_link.rs"
use super::*;

const NOW: &str = "14:02";
const AUTH_TAIL: &str = "user@host: Permission denied (publickey).\r\n";
const TIMEOUT_TAIL: &str = "ssh: connect to host h port 22: Connection timed out\r\n";

fn link(phase: Phase, gen: u64, attempt: u32) -> Link {
    Link {
        phase,
        gen,
        attempt,
        seq: 10,
        ..Link::default()
    }
}

// ── on_exit 판정표 ─────────────────────────────────────────────

// AC-02: 마감으로 끝낸 시도는 출력과 상관없이 다음 시도로(분류하지 않는다)
#[test]
fn on_exit_after_deadline_retries_without_classifying() {
    let mut l = Link {
        timed_out: true,
        ..link(Phase::Connecting, 4, 2)
    };
    assert_eq!(on_exit(&mut l, 4, Some(255), AUTH_TAIL), Exit::Retry);
    assert_eq!((l.phase, l.attempt, l.reason), (Phase::Waiting, 3, None));
}

// AC-10: 사용자가 exit 하면(255 아님) 지금처럼 끝낸다
#[test]
fn on_exit_with_a_code_other_than_255_ends_like_before() {
    for code in [0, 1] {
        let mut l = Link {
            connected: true,
            ..link(Phase::Live, 1, 0)
        };
        assert_eq!(on_exit(&mut l, 1, Some(code), ""), Exit::End, "code {code}");
    }
}

// AC-01: 연결된 뒤의 255 는 끊김 — 1/5 를 기다린다(그 세대 꼬리는 보지 않는다)
#[test]
fn on_exit_255_after_connecting_waits_for_the_first_retry() {
    let mut l = Link {
        connected: true,
        ..link(Phase::Live, 1, 0)
    };
    let seq = l.seq;
    assert_eq!(on_exit(&mut l, 1, Some(255), AUTH_TAIL), Exit::Retry);
    assert_eq!((l.phase, l.attempt), (Phase::Waiting, 1));
    assert!(l.seq > seq);
}

// EC-01: 연결 전 255 + 인증 실패 → 시도하지 않고 바로 실패
#[test]
fn on_exit_255_before_connecting_with_auth_failure_fails_at_once() {
    let mut l = link(Phase::Connecting, 3, 2);
    let tail = format!("\x1b[?25l\x1b]0;C:\\Windows\\System32\\OpenSSH\\ssh.exe\x07{AUTH_TAIL}");
    assert_eq!(on_exit(&mut l, 3, Some(255), &tail), Exit::Fail);
    assert_eq!((l.phase, l.reason), (Phase::Failed, Some("auth")));
}

// EC-01: 연결 전 255 + 호스트 키 확인 실패 → 바로 실패
#[test]
fn on_exit_255_before_connecting_with_host_key_failure_fails_at_once() {
    let mut l = link(Phase::Connecting, 3, 1);
    assert_eq!(
        on_exit(&mut l, 3, Some(255), "Host key verification failed.\r\n"),
        Exit::Fail
    );
    assert_eq!((l.phase, l.reason), (Phase::Failed, Some("host_key")));
}

// AC-02: 연결 전 255 + 네트워크 오류 → 다음 시도
#[test]
fn on_exit_255_before_connecting_with_network_error_retries() {
    let mut l = link(Phase::Connecting, 3, 1);
    assert_eq!(on_exit(&mut l, 3, Some(255), TIMEOUT_TAIL), Exit::Retry);
    assert_eq!((l.phase, l.attempt, l.reason), (Phase::Waiting, 2, None));
}

// AC-11 · EC-01: 처음 열 때(첫 세대: Live, 아직 연결 신호 없음)의 인증 실패도 판정한다
#[test]
fn on_exit_first_generation_auth_failure_fails_without_retrying() {
    let mut l = Link::default();
    assert_eq!(
        on_exit(&mut l, 0, Some(255), "Permission denied (publickey,password).\r\n"),
        Exit::Fail
    );
    assert_eq!((l.phase, l.reason), (Phase::Failed, Some("auth")));
}

// AC-11: 처음 열 때의 255(인증·호스트 키 아님)도 같은 자동 재접속
#[test]
fn on_exit_first_generation_network_error_starts_reconnecting() {
    let mut l = Link::default();
    assert_eq!(
        on_exit(&mut l, 0, Some(255), "ssh: connect to host h port 22: Connection refused\r\n"),
        Exit::Retry
    );
    assert_eq!((l.phase, l.attempt), (Phase::Waiting, 1));
}

// AC-07: 5번째 시도도 실패하면 그만둔다
#[test]
fn on_exit_after_the_fifth_attempt_gives_up() {
    let mut l = link(Phase::Connecting, 7, 5);
    assert_eq!(on_exit(&mut l, 7, Some(255), TIMEOUT_TAIL), Exit::Fail);
    assert_eq!((l.phase, l.attempt, l.reason), (Phase::Failed, 5, None));
}

// ── on_marker ─────────────────────────────────────────────────

// AC-02: 마감으로 끝내기로 한 세대의 늦은 표시는 무시한다
#[test]
fn on_marker_is_ignored_after_the_attempt_timed_out() {
    // 대조: 마감 전이면 연결된다
    let mut ok = link(Phase::Connecting, 2, 3);
    assert!(on_marker(&mut ok, 2, NOW));
    let mut l = Link {
        timed_out: true,
        ..link(Phase::Connecting, 2, 3)
    };
    let before = l.clone();
    assert!(!on_marker(&mut l, 2, NOW));
    assert_eq!(l, before);
}

// AC-11: 첫 세대(Live)의 표시는 연결됐다는 기록만 — 구분 줄 없음
#[test]
fn on_marker_on_live_only_marks_the_generation_connected() {
    let mut l = Link::default();
    assert!(!on_marker(&mut l, 0, NOW));
    assert_eq!(
        (l.phase, l.connected, l.attempt, l.at.clone()),
        (Phase::Live, true, 0, None)
    );
}

// AC-03: 안전망 Live 뒤에 진짜 표시가 오면 시도 횟수만 처음으로(커서 위치를 모르므로 구분 줄 없음)
#[test]
fn on_marker_after_the_safety_net_resets_attempts_without_a_separator() {
    let mut l = Link {
        provisional: true,
        at: Some("13:59".into()),
        ..link(Phase::Live, 4, 3)
    };
    assert!(!on_marker(&mut l, 4, NOW));
    assert_eq!(
        (l.phase, l.attempt, l.provisional, l.connected),
        (Phase::Live, 0, false, true)
    );
}

// AC-03: 시도 중 표시 → 연결됨 + 그 시각 + 구분 줄 신호
#[test]
fn on_marker_while_connecting_goes_live_and_asks_for_the_separator() {
    let mut l = link(Phase::Connecting, 5, 2);
    let seq = l.seq;
    assert!(on_marker(&mut l, 5, NOW));
    assert_eq!(
        (l.phase, l.attempt, l.connected, l.at.as_deref()),
        (Phase::Live, 0, true, Some(NOW))
    );
    assert!(l.seq > seq);
}

// ── on_deadline ───────────────────────────────────────────────

// AC-02: 마감은 같은 세대의 시도 중에 한 번만
#[test]
fn on_deadline_is_ignored_when_live_from_another_generation_or_already_timed_out() {
    // 대조: 같은 세대·시도 중·살아 있음·마감 전이면 끝낸다
    let mut ok = link(Phase::Connecting, 2, 1);
    assert!(on_deadline(&mut ok, 2, true, false, NOW));
    let cases = [
        ("Live", link(Phase::Live, 2, 0), 2),
        ("다른 세대", link(Phase::Connecting, 2, 1), 1),
        (
            "마감 뒤",
            Link {
                timed_out: true,
                ..link(Phase::Connecting, 2, 1)
            },
            2,
        ),
    ];
    for (name, mut l, ev_gen) in cases {
        let before = l.clone();
        assert!(!on_deadline(&mut l, ev_gen, true, false, NOW), "{name}");
        assert_eq!(l, before, "{name}");
    }
}

// AC-02: 마감 때 이미 끝난 ssh 는 곧 올 Eof 가 분류한다
#[test]
fn on_deadline_is_ignored_when_the_ssh_already_exited() {
    let mut ok = link(Phase::Connecting, 2, 1);
    assert!(on_deadline(&mut ok, 2, true, false, NOW));
    let mut l = link(Phase::Connecting, 2, 1);
    let before = l.clone();
    assert!(!on_deadline(&mut l, 2, false, false, NOW));
    assert!(!on_deadline(&mut l, 2, false, true, NOW));
    assert_eq!(l, before);
}

// AC-03: 표시가 빠진 환경 — 살아 있고 보이는 출력이 있으면 안전망으로 연결됨(시도 횟수 유지, 구분 줄 없음)
#[test]
fn on_deadline_with_visible_output_falls_back_to_a_provisional_live() {
    let mut l = link(Phase::Connecting, 2, 3);
    let seq = l.seq;
    assert!(!on_deadline(&mut l, 2, true, true, NOW));
    assert_eq!(
        (l.phase, l.provisional, l.connected, l.attempt, l.timed_out),
        (Phase::Live, true, false, 3, false)
    );
    assert_eq!(l.at.as_deref(), Some(NOW));
    assert!(l.seq > seq);
}

// AC-02: 보이는 출력도 없으면 그 시도를 끝낸다
#[test]
fn on_deadline_without_visible_output_times_the_attempt_out() {
    let mut l = link(Phase::Connecting, 2, 3);
    assert!(on_deadline(&mut l, 2, true, false, NOW));
    assert!(l.timed_out);
    assert_eq!(l.phase, Phase::Connecting);
}

// ── visible ───────────────────────────────────────────────────

// AC-03: ConPTY 의 시작 시퀀스·ssh.exe 경로 제목은 보이는 출력이 아니다
#[test]
fn visible_ignores_the_conpty_startup_sequences_and_title() {
    let start = "\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]0;C:\\WINDOWS\\System32\\OpenSSH\\ssh.exe\x07\x1b[?25h";
    assert!(!visible(start));
    assert!(visible(&format!("{start}Permission denied (publickey).\r\n")));
}

// AC-03: 크기를 바꿔 다시 그린 CR·LF·EL(과 ESC 2바이트 시퀀스)은 보이는 출력이 아니다
#[test]
fn visible_ignores_a_resize_redraw() {
    let redraw = "\x1b7\r\n\x1b[K\r\x1b[K\n\x1b[2K\r \t\r\n\x1b8";
    assert!(!visible(redraw));
    assert!(visible(&format!("{redraw}$ ")));
}

// AC-03: 끝 4KB 만 보고, 그때 잘린 앞 조각(제목의 중간)은 세지 않는다
#[test]
fn visible_only_looks_at_the_tail_and_drops_the_cut_fragment() {
    let fragment = "Windows\\System32\\OpenSSH\\ssh.exe\x07";
    let mut tail = fragment.to_string();
    while tail.len() + 6 <= TAIL_LIMIT {
        tail.push_str("\x1b[2K\r\n");
    }
    while tail.len() < TAIL_LIMIT {
        tail.push('\r');
    }
    // 끝 TAIL_LIMIT 바이트가 창 제목의 중간에서 시작한다. 그 앞의 프롬프트는 끝 4KB 밖이다
    let text = format!("user@host:~$ ls\r\n\x1b]0;C:\\{tail}");
    assert!(!visible(&text));
    assert!(visible(&format!("{text}$ ")));
}

// ── on_request ────────────────────────────────────────────────

// AC-08: 기다리는 중 [지금 재접속] → 그 시도를 바로. 연결됨·시도 중이면 무시
#[test]
fn on_request_while_waiting_tries_now_and_is_ignored_when_live_or_connecting() {
    let mut l = link(Phase::Waiting, 0, 3);
    assert!(on_request(&mut l));
    assert_eq!((l.phase, l.attempt), (Phase::Waiting, 3));
    for phase in [Phase::Live, Phase::Connecting] {
        let mut l = link(phase, 0, 2);
        let before = l.clone();
        assert!(!on_request(&mut l), "{phase:?}");
        assert_eq!(l, before, "{phase:?}");
    }
}

// AC-07: 실패 뒤 [재접속] → 1/5 부터 다시
#[test]
fn on_request_after_failing_starts_over_from_the_first_attempt() {
    let mut l = Link {
        reason: Some("auth"),
        ..link(Phase::Failed, 0, 5)
    };
    assert!(on_request(&mut l));
    assert_eq!((l.phase, l.attempt), (Phase::Waiting, 1));
}

// ── 세대 ──────────────────────────────────────────────────────

// AC-02: 새 시도(세대)는 지난 세대의 연결·마감 기록을 잇지 않는다
#[test]
fn advance_gen_resets_the_per_generation_flags() {
    let mut l = Link {
        connected: true,
        timed_out: true,
        ..link(Phase::Connecting, 3, 2)
    };
    assert_eq!(l.advance_gen(), 4);
    assert_eq!((l.gen, l.connected, l.timed_out), (4, false, false));
}

// AC-02: 늦게 온 옛 세대의 Eof·표시·마감, 기다리는 중·실패 뒤의 세대 이벤트는 무시한다
#[test]
fn generation_events_are_ignored_for_an_old_generation_or_while_waiting_or_failed() {
    // 대조: 지금 세대의 Eof 는 반영된다
    let mut ok = link(Phase::Connecting, 3, 1);
    assert_eq!(on_exit(&mut ok, 3, Some(255), TIMEOUT_TAIL), Exit::Retry);

    let mut l = link(Phase::Connecting, 3, 1);
    let before = l.clone();
    assert_eq!(on_exit(&mut l, 2, Some(255), TIMEOUT_TAIL), Exit::Ignored);
    assert!(!on_marker(&mut l, 2, NOW));
    assert!(!on_deadline(&mut l, 2, true, false, NOW));
    assert_eq!(l, before);

    for phase in [Phase::Waiting, Phase::Failed] {
        let mut l = link(phase, 3, 2);
        let before = l.clone();
        assert_eq!(on_exit(&mut l, 3, Some(255), TIMEOUT_TAIL), Exit::Ignored, "{phase:?}");
        assert!(!on_marker(&mut l, 3, NOW), "{phase:?}");
        assert!(!on_deadline(&mut l, 3, true, false, NOW), "{phase:?}");
        assert_eq!(l, before, "{phase:?}");
    }
}

// ── normalize_tail ────────────────────────────────────────────

// EC-01: ConPTY 가 끼워 넣은 제어 문자열·제목 때문에 ssh 오류 문구를 놓치지 않는다
#[test]
fn normalize_tail_strips_control_sequences_and_title_text() {
    let raw = "\x1b[?25l\x1b]0;C:\\Windows\\System32\\OpenSSH\\ssh.exe\x07\x1b[31mPermission\x1b[?25h denied (publickey).\x1b[m\r\n\x1b[K";
    let out = normalize_tail(raw);
    assert!(out.contains("Permission denied (publickey)."), "{out:?}");
    assert!(!out.contains('\x1b'), "{out:?}");
    assert!(!out.contains("ssh.exe"), "{out:?}");
}

// ── MarkerFilter ──────────────────────────────────────────────

// AC-03: 표시(창 제목 minmo-link)는 OSC 0·2, BEL·ST 어느 쪽이든 빼고 알린다
#[test]
fn marker_filter_takes_out_the_marker_in_osc_0_and_2_with_bel_or_st() {
    for marker in [
        "\x1b]0;minmo-link\x07",
        "\x1b]2;minmo-link\x07",
        "\x1b]2;minmo-link\x1b\\",
    ] {
        let mut f = MarkerFilter::new(false);
        let (head, sig) = f.filter(&format!("abc{marker}def"), false);
        assert_eq!(head, "abc", "{marker:?}");
        assert_eq!(sig, Some((Signal::Marker, "def".to_string())), "{marker:?}");
    }
}

// AC-03: 조각 경계에서 잘린 표시도 찾는다
#[test]
fn marker_filter_finds_a_marker_split_across_chunks() {
    let mut f = MarkerFilter::new(false);
    assert_eq!(f.filter("abc\x1b]2;min", false), ("abc".to_string(), None));
    assert_eq!(
        f.filter("mo-link\x07def", false),
        (String::new(), Some((Signal::Marker, "def".to_string())))
    );
}

// AC-03: 표시가 아닌 출력(다른 제목·색·링크)은 그대로 둔다
#[test]
fn marker_filter_passes_other_output_through() {
    let mut f = MarkerFilter::new(false);
    let text = "hello \x1b]0;my title\x07\x1b[31mred\x1b[m \x1b]8;;https://x.y\x07link\x1b]8;;\x07\r\n";
    assert_eq!(f.filter(text, false), (text.to_string(), None));
}

// AC-04: tmux 세션은 tmux 제목(minmo:)도 연결 신호다 — 제목은 출력에 남긴다
#[test]
fn marker_filter_treats_the_tmux_title_as_a_signal_and_keeps_it() {
    let mut f = MarkerFilter::new(true);
    let (head, sig) = f.filter("a\x1b]0;minmo:bash:~\x07b", false);
    assert_eq!(head, "a\x1b]0;minmo:bash:~\x07");
    assert_eq!(sig, Some((Signal::Tmux, "b".to_string())));
    // tmux 세션이 아니면 그냥 제목이다
    let mut f = MarkerFilter::new(false);
    assert_eq!(
        f.filter("a\x1b]0;minmo:bash:~\x07b", false),
        ("a\x1b]0;minmo:bash:~\x07b".to_string(), None)
    );
}

// AC-03 · AC-04: 시도 중에는 제목(ConPTY 의 ssh.exe 경로)을 모두 빼고, 안전망 Live 뒤에는 그대로 둔다.
// tmux 제목은 시도 중이어도 연결 신호로 남긴다
#[test]
fn marker_filter_strips_titles_while_connecting_and_passes_them_after() {
    let ssh_title = "\x1b]0;C:\\Windows\\System32\\OpenSSH\\ssh.exe\x07";
    let mut f = MarkerFilter::new(false);
    assert_eq!(
        f.filter(&format!("x{ssh_title}y\x1b]2;t\x1b\\z"), true),
        ("xyz".to_string(), None)
    );
    assert_eq!(
        f.filter(&format!("x{ssh_title}y"), false),
        (format!("x{ssh_title}y"), None)
    );
    let mut f = MarkerFilter::new(true);
    let (head, sig) = f.filter(&format!("{ssh_title}\x1b]0;minmo:bash:~\x07b"), true);
    assert_eq!(head, "\x1b]0;minmo:bash:~\x07");
    assert_eq!(sig, Some((Signal::Tmux, "b".to_string())));
}

// ── 준비 시퀀스·구분 줄·CPR ───────────────────────────────────

// AC-03: 끊기기 전 프로그램의 대체 화면·켜 둔 모드를 끄고, 맨 아래 새 줄에서 새 셸을 시작한다
#[test]
fn reattach_prelude_leaves_the_alt_screen_resets_and_moves_to_a_new_bottom_line() {
    let modes: BTreeMap<u16, bool> = [
        (1049, true),
        (1000, true),
        (1006, true),
        (2004, true),
        (1004, false),
        (25, false),
    ]
    .into_iter()
    .collect();
    let p = reattach_prelude(&modes, 30, true);
    assert!(p.starts_with("\x1b[?1049l"), "{p:?}");
    for on in ["\x1b[?1000l", "\x1b[?1006l", "\x1b[?2004l"] {
        assert!(p.contains(on), "{on:?} in {p:?}");
    }
    // 꺼져 있던 모드는 건드리지 않는다
    assert!(!p.contains("\x1b[?1004l"), "{p:?}");
    // DECSTR 뒤에 커서 보임·커서 키·자동 줄바꿈을 명시한다(Scrollback 의 모드 기록도 맞게)
    let decstr = p.find("\x1b[!p").unwrap_or_else(|| panic!("DECSTR in {p:?}"));
    for explicit in ["\x1b[?25h", "\x1b[?1l", "\x1b[?7h"] {
        let at = p
            .find(explicit)
            .unwrap_or_else(|| panic!("{explicit:?} in {p:?}"));
        assert!(at > decstr, "{explicit:?} after DECSTR in {p:?}");
    }
    assert!(p.contains("\x1b[0 q"), "{p:?}");
    assert!(p.contains("\x1b]0;\x07"), "{p:?}");
    assert!(p.ends_with("\x1b[30;1H\r\n"), "{p:?}");
}

// AC-04: 대체 화면이 아니면 끄지 않고, tmux 세션은 제목을 지우지 않는다(tmux 가 정한 제목 유지)
#[test]
fn reattach_prelude_without_alt_screen_keeps_the_title_for_tmux() {
    let p = reattach_prelude(&BTreeMap::new(), 24, false);
    assert!(!p.contains("\x1b[?1049l"), "{p:?}");
    assert!(p.contains("\x1b[!p"), "{p:?}");
    assert!(!p.contains("\x1b]0;"), "{p:?}");
    assert!(p.ends_with("\x1b[24;1H\r\n"), "{p:?}");
}

// AC-03: 구분 줄 한 줄 — `── 연결이 끊겨 다시 접속했습니다 (HH:MM) ──`
#[test]
fn separator_is_one_line_with_the_time() {
    let s = separator("14:02");
    let text = "── 연결이 끊겨 다시 접속했습니다 (14:02) ──";
    let at = s.find(text).unwrap_or_else(|| panic!("{s:?}"));
    assert!(s[at + text.len()..].contains('\n'), "{s:?}");
}

// AC-03: 새 ConPTY 의 시작 질의에는 준비 시퀀스가 둔 맨 아래 행으로 답한다
#[test]
fn cpr_reply_reports_the_bottom_row() {
    assert_eq!(cpr_reply(30), "\x1b[30;1R");
}
