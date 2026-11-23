// 원격 터미널 재접속 감독(#89). 원격 세션마다 스레드 하나가 끊김(Eof)·[지금 재접속](Kick)·시간을 받아
// pty_link 의 전이를 적용하고 새 ssh 를 연다. 원격 세션의 pty-exit 는 이 감독만 낸다.
use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, MutexGuard};
use std::time::{Duration, Instant};

use tauri::State;

use super::pty::{self, Hub, Proc, PtySession, PtyState};
use super::pty_link::{self, Ev, Exit, Phase, MAX_ATTEMPTS};

/// Eof 뒤 종료 코드를 기다리는 간격과 상한 — 출력이 닫힌 직후에는 프로세스가 아직 끝나는 중일 수 있다
const EXIT_POLL: Duration = Duration::from_millis(50);
const EXIT_WAIT: Duration = Duration::from_secs(2);

/// [지금 재접속]·[재접속] — 기다림 없이 바로 시도한다(AC-07·AC-08)
#[tauri::command]
pub fn pty_reconnect(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    kick(state.hub(), &id)
}

pub(crate) fn kick(hub: &Hub, id: &str) -> Result<(), String> {
    let sessions = hub.sessions.lock().map_err(|e| e.to_string())?;
    let s = sessions.get(id).ok_or_else(|| format!("pty {id} 없음"))?;
    if let Some(tx) = &s.tx {
        let _ = tx.send(Ev::Kick);
    }
    Ok(())
}

/// 감독 스레드 본문 — setup 에서 Hub 에 넣는다(pty::SupervisorFn)
pub(crate) fn supervise(hub: Arc<Hub>, id: String, rx: Receiver<Ev>) {
    let now = Instant::now();
    let poll = hub.timing.poll;
    Supervisor {
        hub,
        id,
        rx,
        waiting_since: now,
        started: now,
        deadline_done: false,
        next_poll: now + poll,
        stale: None,
    }
    .run();
}

type Sessions<'a> = MutexGuard<'a, HashMap<String, PtySession>>;

/// 끝난(또는 마감으로 끝낸) 세대 — 그 Eof 를 유예까지 기다린다
#[derive(Clone, Copy)]
struct Stale {
    gen: u64,
    since: Instant,
    /// 감독이 본 종료 코드(마감으로 끝냈으면 None — 판정에 쓰지 않는다)
    code: Option<u32>,
}

enum Flow {
    Go,
    /// 감독을 끝낸다 — 세션이 없어졌거나 끝났다. 끝난 세션의 Proc 는 pty-exit 를 낸 뒤 정리한다
    Stop(Option<Proc>),
}

struct Supervisor {
    hub: Arc<Hub>,
    id: String,
    rx: Receiver<Ev>,
    /// Waiting 에 들어간 시각 — 기다림은 이 시각부터 센다(무시한 이벤트로 깨어나도 늘어나지 않게)
    waiting_since: Instant,
    /// 지금 시도를 시작한 시각(마감 계산)
    started: Instant,
    /// 이 시도의 마감을 처리했다
    deadline_done: bool,
    /// 세션 확인·EOF 없는 종료 확인의 다음 시각
    next_poll: Instant,
    stale: Option<Stale>,
}

impl Supervisor {
    fn run(mut self) {
        let leftover = loop {
            #[cfg(test)]
            self.hub
                .wakes
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let Some(wake) = self.wake_at() else {
                break None;
            };
            let flow = match self
                .rx
                .recv_timeout(wake.saturating_duration_since(Instant::now()))
            {
                Ok(Ev::Eof { gen }) => self.on_eof(gen),
                Ok(Ev::Kick) => self.on_kick(),
                Err(RecvTimeoutError::Timeout) => self.on_wake(),
                // 세션을 뺀 쪽(pty_kill·kill_all·pty_kill_by_cwd)이 통로를 먼저 닫았다
                Err(RecvTimeoutError::Disconnected) => Flow::Stop(None),
            };
            if let Flow::Stop(proc) = flow {
                break proc;
            }
        };
        // 원격 세션의 pty-exit 는 여기서만 낸다 — 어떤 경로로 끝나든 정확히 한 번
        if let Some(sink) = self.hub.sink() {
            sink.exit(&self.id);
        }
        if let Some(proc) = leftover {
            pty::kill_and_close(vec![proc]);
        }
    }

    /// 다음에 깨어날 절대 시각. 세션이 없으면 None
    fn wake_at(&self) -> Option<Instant> {
        let sessions = lock(&self.hub)?;
        let link = &sessions.get(&self.id)?.link;
        let t = &self.hub.timing;
        let at = match link.phase {
            Phase::Waiting => self.waiting_since + t.delays[delay_index(link.attempt)],
            Phase::Connecting if !self.deadline_done => self.started + t.deadline,
            _ => self.next_poll,
        };
        let grace = self
            .stale
            .filter(|st| st.gen == link.gen)
            .map(|st| st.since + t.grace);
        Some(grace.map_or(at, |g| g.min(at)))
    }

    fn on_kick(&mut self) -> Flow {
        {
            let Some(mut sessions) = lock(&self.hub) else {
                return Flow::Stop(None);
            };
            let Some(s) = sessions.get_mut(&self.id) else {
                return Flow::Stop(None);
            };
            if !pty_link::on_request(&mut s.link) {
                return Flow::Go;
            }
        }
        self.attempt()
    }

    fn on_wake(&mut self) -> Flow {
        let hub = self.hub.clone();
        let t = &hub.timing;
        let now = Instant::now();
        if now >= self.next_poll {
            self.next_poll = now + t.poll;
        }
        let Some(mut sessions) = lock(&hub) else {
            return Flow::Stop(None);
        };
        let Some(s) = sessions.get_mut(&self.id) else {
            return Flow::Stop(None);
        };
        let gen = s.link.gen;
        match s.link.phase {
            Phase::Failed => return Flow::Go,
            Phase::Waiting => {
                if now >= self.waiting_since + t.delays[delay_index(s.link.attempt)] {
                    drop(sessions);
                    return self.attempt();
                }
                return Flow::Go;
            }
            Phase::Live | Phase::Connecting => {}
        }
        if s.link.phase == Phase::Connecting
            && !self.deadline_done
            && now >= self.started + t.deadline
        {
            self.deadline_done = true;
            let alive = s.proc.alive();
            let seen = pty_link::visible(&s.proc.shared.tail());
            let seq = s.link.seq;
            if pty_link::on_deadline(&mut s.link, gen, alive, seen, &pty::now_hhmm()) {
                // 표시도 보이는 출력도 없이 멈춘 시도 — ssh 와 그 자손(ProxyCommand 등)을 잠금 밖에서 끝낸다.
                // 곧 올 Eof 가 다음 시도로 넘긴다(유예 안에 오지 않으면 감독이 넘긴다)
                let stop = s.proc.stopper();
                drop(sessions);
                stop.stop();
                self.stale = Some(Stale {
                    gen,
                    since: Instant::now(),
                    code: None,
                });
                return Flow::Go;
            }
            if s.link.seq != seq {
                // 안전망 Live(표시가 빠진 환경·프롬프트 인증) — 입력을 받고 제목을 다시 통과시킨다
                s.proc.shared.set_connecting(false);
                pty::announce(&hub, &self.id, s, None);
            }
        }
        // EOF 없는 종료: ssh 는 끝났는데 출력이 닫히지 않는다(자손이 PTY 를 쥔 경우 등) — 유예 뒤 감독이 대신 판정한다
        if let Ok(Some(code)) = s.proc.exit_code() {
            if self.stale.map_or(true, |st| st.gen != gen) {
                self.stale = Some(Stale {
                    gen,
                    since: now,
                    code: Some(code),
                });
            }
        }
        match self.stale {
            Some(st) if st.gen == gen && now >= st.since + t.grace => {
                self.apply_exit(sessions, gen, st.code, true)
            }
            _ => Flow::Go,
        }
    }

    /// 그 세대의 출력이 끝났다 — 종료 코드를 읽어 판정한다. 옛 세대·기다림·실패 중이면 무시한다(기다림 시각은 그대로)
    fn on_eof(&mut self, gen: u64) -> Flow {
        let hub = self.hub.clone();
        let until = Instant::now() + EXIT_WAIT;
        let code = loop {
            {
                // 폴링마다 잠금을 짧게 잡았다 놓는다 — 그동안 입력·크기·다른 화면이 막히지 않게
                let Some(mut sessions) = lock(&hub) else {
                    return Flow::Stop(None);
                };
                let Some(s) = sessions.get_mut(&self.id) else {
                    return Flow::Stop(None);
                };
                if !s.link.current(gen) {
                    return Flow::Go;
                }
                match s.proc.exit_code() {
                    Ok(Some(code)) => break Some(code),
                    Ok(None) => {}
                    Err(_) => break None,
                }
            }
            if Instant::now() >= until {
                break None;
            }
            std::thread::sleep(EXIT_POLL);
        };
        let Some(sessions) = lock(&hub) else {
            return Flow::Stop(None);
        };
        self.apply_exit(sessions, gen, code, false)
    }

    /// 끝난 세대의 판정을 반영한다. by_supervisor: Eof 없이 감독이 대신 처리했다 — 세대를 올려 옛 리더의 늦은 출력·Eof 를
    /// 버리고 남은 자손을 끝낸다(그 Proc 는 다음 시도에 교체될 때 정리된다)
    fn apply_exit(
        &mut self,
        mut sessions: Sessions<'_>,
        gen: u64,
        code: Option<u32>,
        by_supervisor: bool,
    ) -> Flow {
        let Some(s) = sessions.get_mut(&self.id) else {
            return Flow::Stop(None);
        };
        let tail = s.proc.shared.tail();
        let exit = pty_link::on_exit(&mut s.link, gen, code, &tail);
        match exit {
            Exit::Ignored => Flow::Go,
            // 사용자가 끝냈다(255 아님) — 지금처럼 세션을 치우고 pty-exit
            Exit::End => Flow::Stop(pty::take(&mut sessions, &self.id).map(|s| s.proc)),
            Exit::Retry | Exit::Fail => {
                self.stale = None;
                if exit == Exit::Retry {
                    self.waiting_since = Instant::now();
                }
                let stop = by_supervisor.then(|| {
                    s.advance_gen();
                    s.proc.stopper()
                });
                pty::announce(&self.hub, &self.id, s, None);
                drop(sessions);
                if let Some(stop) = stop {
                    stop.stop();
                }
                Flow::Go
            }
        }
    }

    /// 다음 시도 — 새 ssh 는 잠금 밖에서 열고, 잠금 안에서 세션이 그대로인지 본 뒤 넣는다
    fn attempt(&mut self) -> Flow {
        let hub = self.hub.clone();
        let (remote, cwd, cols, rows, attempt) = {
            let Some(sessions) = lock(&hub) else {
                return Flow::Stop(None);
            };
            let Some(s) = sessions.get(&self.id) else {
                return Flow::Stop(None);
            };
            if s.link.phase != Phase::Waiting {
                return Flow::Go;
            }
            (
                s.remote.clone(),
                s.cwd.clone(),
                s.cols,
                s.rows,
                s.link.attempt,
            )
        };
        // 처음 연 요청(tmux 설정 포함, EC-06)으로 연다. 호스트 정보는 Spawner 가 시도마다 새로 읽는다(EC-07)
        let opened = match &remote {
            Some(r) => (self.hub.spawner)(r, &cwd, cols, rows),
            None => Err("원격 세션이 아닙니다".to_string()),
        };
        let Some(mut sessions) = lock(&hub) else {
            if let Ok(o) = opened {
                pty::discard(o);
            }
            return Flow::Stop(None);
        };
        let Some(s) = sessions.get_mut(&self.id) else {
            drop(sessions);
            if let Ok(o) = opened {
                pty::discard(o);
            }
            return Flow::Stop(None);
        };
        if s.link.phase != Phase::Waiting || s.link.attempt != attempt {
            drop(sessions);
            if let Ok(o) = opened {
                pty::discard(o);
            }
            return Flow::Go;
        }
        let opened = match opened {
            Ok(o) => o,
            Err(_) => {
                // 호스트를 목록에서 뺐거나 ssh·PTY 를 열 수 없다 — 다시 해도 같다(EC-07)
                pty_link::on_spawn_error(&mut s.link);
                pty::announce(&self.hub, &self.id, s, None);
                return Flow::Go;
            }
        };
        let (old, reader) = pty::swap_in(&self.hub, &self.id, s, opened, (cols, rows));
        drop(sessions);
        reader.start();
        // 옛 Proc 는 이미 끝난 ssh — 닫기가 멈춰도 감독이 막히지 않게 백그라운드에서
        std::thread::spawn(move || pty::kill_and_close(vec![old]));
        self.started = Instant::now();
        self.deadline_done = false;
        self.stale = None;
        Flow::Go
    }
}

fn lock(hub: &Hub) -> Option<Sessions<'_>> {
    hub.sessions.lock().ok()
}

/// n 번째 시도 전 기다림의 자리(1..=MAX_ATTEMPTS)
fn delay_index(attempt: u32) -> usize {
    (attempt.clamp(1, MAX_ATTEMPTS) - 1) as usize
}

#[cfg(test)]
#[path = "pty_reconnect_tests.rs"]
mod tests;
