// 내장 서버 — 설치 파일에 함께 들어간 사이드카 minmo-server 를 앱과 함께 띄우고 끈다.
// 서버 설정은 데스크탑이 갖고(server.json + OS 키체인) env 로 넘긴다. 토큰 암호화 키는 처음 실행할 때 만들어
// 키체인에 두고, OAuth Client Secret 은 쓰기 전용(웹뷰에는 저장 여부만)이다.
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::keychain;
use crate::profile;

pub const DEFAULT_PORT: u16 = 8787;
pub const STATUS_EVENT: &str = "server-status";
const SETTINGS_FILE: &str = "server.json";
const TOKEN_KEY: &str = "minmo.server.token-key";
/// 예전 버전이 키체인에 넣어 둔 OAuth App Client Secret — 기기 코드 로그인에는 쓰지 않아 시작할 때 지운다
const LEGACY_CLIENT_SECRET_KEY: &str = "minmo.server.github-client-secret";
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_GRACE: Duration = Duration::from_secs(5);
/// debug 빌드에서 상속을 허용하는 env — githubmock 으로 로그인 흐름을 E2E 할 때 쓴다
const DEBUG_PASSTHROUGH: [&str; 3] = [
    "MINMO_GITHUB_OAUTH_BASE",
    "MINMO_GITHUB_API_BASE",
    "MINMO_GITHUB_CLIENT_ID",
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    /// 닫을 때마다 묻는다
    #[default]
    Ask,
    /// 트레이로 숨긴다(서버 유지)
    Tray,
    /// 앱과 서버를 끝낸다
    Quit,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub port: u16,
    pub close_action: CloseAction,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            close_action: CloseAction::Ask,
        }
    }
}

pub fn validate_port(port: u16) -> Result<(), String> {
    if port < 1024 {
        Err(format!("포트는 1024~65535 사이여야 합니다 (입력: {port})"))
    } else {
        Ok(())
    }
}

/// 없으면 기본값. 읽을 수 없거나 형식이 틀리면 기본값과 경고 문구
pub fn load_settings(path: &Path) -> (Settings, Option<String>) {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (Settings::default(), None),
        Err(e) => {
            return (
                Settings::default(),
                Some(format!(
                    "서버 설정 파일을 읽지 못해 기본값으로 시작했습니다: {e}"
                )),
            )
        }
    };
    match serde_json::from_str::<Settings>(&text) {
        Ok(mut s) => match validate_port(s.port) {
            Ok(()) => (s, None),
            Err(e) => {
                s.port = DEFAULT_PORT;
                (
                    s,
                    Some(format!("{e} — 기본 포트 {DEFAULT_PORT} 로 시작했습니다")),
                )
            }
        },
        Err(e) => (
            Settings::default(),
            Some(format!(
                "서버 설정 파일 형식이 잘못되어 기본값으로 시작했습니다: {e}"
            )),
        ),
    }
}

/// 임시 파일에 쓴 뒤 바꿔 넣어, 쓰는 중에 앱이 끝나도 설정 파일이 깨지지 않게 한다
pub fn save_settings(path: &Path, s: &Settings) -> Result<(), String> {
    let err = |e: std::io::Error| format!("서버 설정을 저장하지 못했습니다: {e}");
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(err)?;
    fs::rename(&tmp, path).map_err(err)
}

pub struct Launch {
    pub port: u16,
    pub db_path: PathBuf,
    pub token_key: String,
}

/// 서버 env — 상속된 MINMO_* 는 지우고(사용자 env 가 섞이지 않게) 필요한 값만 넣는다. (지울 키, 넣을 값)
pub fn server_env(
    launch: &Launch,
    inherited: impl Iterator<Item = String>,
    debug: bool,
) -> (Vec<String>, Vec<(String, String)>) {
    let remove = inherited
        .filter(|k| {
            let upper = k.to_ascii_uppercase();
            upper.starts_with("MINMO_") && !(debug && DEBUG_PASSTHROUGH.contains(&upper.as_str()))
        })
        .collect();
    let addr = format!("127.0.0.1:{}", launch.port);
    let set = vec![
        ("MINMO_LISTEN".to_string(), addr.clone()),
        ("MINMO_PUBLIC_URL".to_string(), format!("http://{addr}")),
        (
            "MINMO_DB_PATH".to_string(),
            launch.db_path.to_string_lossy().into_owned(),
        ),
        ("MINMO_TOKEN_KEY".to_string(), launch.token_key.clone()),
        ("MINMO_STOP_ON_STDIN_CLOSE".to_string(), "1".to_string()),
    ];
    (remove, set)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Starting,
    Running,
    Failed,
    Stopped,
    /// debug 전용: 외부에서 띄운 서버를 쓴다(MINMO_EXTERNAL_SERVER=1)
    External,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: State,
    pub port: u16,
    pub message: Option<String>,
}

fn external() -> bool {
    cfg!(debug_assertions) && std::env::var("MINMO_EXTERNAL_SERVER").as_deref() == Ok("1")
}

fn sidecar_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or_else(|| "실행 파일 위치를 알 수 없습니다".to_string())?;
    let name = if cfg!(windows) {
        "minmo-server.exe"
    } else {
        "minmo-server"
    };
    Ok(dir.join(name))
}

/// 키체인의 토큰 암호화 키. 없거나 형식이 틀리면 새로 만든다(바뀌면 저장된 GitHub 토큰은 재로그인 전까지 못 쓴다)
fn token_key() -> Result<String, String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    if let Some(k) = keychain::get(TOKEN_KEY)? {
        if b64.decode(k.trim()).map(|v| v.len() == 32).unwrap_or(false) {
            return Ok(k.trim().to_string());
        }
    }
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).map_err(|e| format!("서버 키를 만들 수 없습니다: {e}"))?;
    let key = b64.encode(buf);
    keychain::set(TOKEN_KEY, &key)?;
    Ok(key)
}

fn port_free(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

fn accepting(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// server.log 를 새로 연다(이전 실행 로그는 server.prev.log)
fn open_log(dir: &Path) -> Result<(File, PathBuf), String> {
    let err = |e: std::io::Error| format!("서버 로그 파일을 열 수 없습니다: {e}");
    fs::create_dir_all(dir).map_err(err)?;
    let log = dir.join("server.log");
    if log.exists() {
        let _ = fs::rename(&log, dir.join("server.prev.log"));
    }
    Ok((File::create(&log).map_err(err)?, log))
}

/// 로그 끝 몇 줄 — 실패 원인(서버가 남긴 마지막 오류)을 화면에 보여 준다
pub fn log_tail(path: &Path, lines: usize) -> String {
    let Ok(mut f) = File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(4096)));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let all: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

struct Proc {
    child: Child,
    stdin: Option<ChildStdin>,
    #[cfg(windows)]
    job: Option<crate::commands::job::Job>,
    log: PathBuf,
}

impl Proc {
    /// stdin 을 닫아 정상 종료를 알리고, grace 안에 끝나지 않으면 강제 종료한다
    fn stop(mut self, grace: Duration) {
        drop(self.stdin.take());
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Inner {
    settings: Settings,
    warning: Option<String>,
    status: Status,
    proc: Option<Proc>,
    /// 시작·정지마다 올린다 — 이전 실행을 지켜보던 스레드가 새 실행의 상태를 덮어쓰지 않게
    generation: u64,
}

pub struct ServerManager {
    inner: Mutex<Inner>,
    /// 시작·재시작을 한 번에 하나만
    op: Mutex<()>,
    /// 앱 종료 중 — 대기 중이던 재시작이 서버를 새로 띄우지 않게
    shutting_down: AtomicBool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    pub port: Option<u16>,
    pub close_action: Option<CloseAction>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub port: u16,
    pub close_action: CloseAction,
    pub warning: Option<String>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl ServerManager {
    pub fn load(app: &AppHandle) -> Self {
        let (settings, warning) = match profile::dirs(app) {
            Ok(d) => load_settings(&d.config.join(SETTINGS_FILE)),
            Err(e) => (Settings::default(), Some(e)),
        };
        Self::new(settings, warning)
    }

    pub fn new(settings: Settings, warning: Option<String>) -> Self {
        let status = Status {
            state: State::Stopped,
            port: settings.port,
            message: None,
        };
        Self {
            inner: Mutex::new(Inner {
                settings,
                warning,
                status,
                proc: None,
                generation: 0,
            }),
            op: Mutex::new(()),
            shutting_down: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> Status {
        lock(&self.inner).status.clone()
    }

    pub fn settings(&self) -> Settings {
        lock(&self.inner).settings.clone()
    }

    fn set_status(&self, app: &AppHandle, generation: u64, status: Status) {
        {
            let mut inner = lock(&self.inner);
            if inner.generation != generation {
                return;
            }
            inner.status = status.clone();
        }
        publish(app, &status);
    }

    /// 서버를 시작하고 준비될 때까지 기다린다(호출 스레드를 막는다 — 백그라운드 스레드에서 부른다)
    pub fn start(&self, app: &AppHandle) {
        let _op = lock(&self.op);
        self.start_locked(app);
    }

    /// 백그라운드에서 정지 후 다시 시작한다. 진행 중인 시작은 무효로 하고(이전 설정으로 running 을 알리지 않게,
    /// 남은 프로세스는 재시작 스레드의 stop_proc 이 끈다) 상태는 곧바로 starting(새 포트)으로 알린다
    pub fn restart(app: &AppHandle) {
        let mgr = app.state::<ServerManager>();
        let status = {
            let mut inner = lock(&mgr.inner);
            inner.generation += 1;
            inner.status = Status {
                state: State::Starting,
                port: inner.settings.port,
                message: None,
            };
            inner.status.clone()
        };
        publish(app, &status);
        let app = app.clone();
        std::thread::spawn(move || {
            let mgr = app.state::<ServerManager>();
            let _op = lock(&mgr.op);
            mgr.stop_proc();
            mgr.start_locked(&app);
        });
    }

    /// 앱 종료 — 진행 중인 시작을 기다리지 않는다(남은 프로세스는 Job Object 가 함께 끝낸다)
    pub fn shutdown(&self, app: &AppHandle) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let generation = self.stop_proc();
        self.set_status(
            app,
            generation,
            Status {
                state: State::Stopped,
                port: self.settings().port,
                message: None,
            },
        );
    }

    /// 종료(shutdown)를 취소하고 서버를 다시 띄운다 — 업데이트 설치가 실패했을 때
    pub fn resume(app: &AppHandle) {
        app.state::<ServerManager>()
            .shutting_down
            .store(false, Ordering::SeqCst);
        Self::restart(app);
    }

    /// 실행 중인 서버를 끝내고 새 세대 번호를 돌려준다
    fn stop_proc(&self) -> u64 {
        let (proc, generation) = {
            let mut inner = lock(&self.inner);
            inner.generation += 1;
            (inner.proc.take(), inner.generation)
        };
        if let Some(p) = proc {
            p.stop(STOP_GRACE);
        }
        generation
    }

    fn start_locked(&self, app: &AppHandle) {
        if self.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let (settings, generation) = {
            let mut inner = lock(&self.inner);
            inner.generation += 1;
            (inner.settings.clone(), inner.generation)
        };
        let port = settings.port;
        let status = |state, message| Status {
            state,
            port,
            message,
        };
        if external() {
            self.set_status(app, generation, status(State::External, None));
            return;
        }
        self.set_status(app, generation, status(State::Starting, None));
        let log = match self.spawn(app, &settings, generation) {
            Ok(log) => log,
            Err(msg) => {
                self.set_status(app, generation, status(State::Failed, Some(msg)));
                return;
            }
        };
        match self.wait_ready(port, generation) {
            Ready::Yes => {
                self.set_status(app, generation, status(State::Running, None));
                self.watch(app, generation);
            }
            Ready::Exited(code) => {
                let msg = format!(
                    "서버가 시작하자마자 종료되었습니다({code}).\n{}",
                    log_tail(&log, 5)
                );
                self.set_status(app, generation, status(State::Failed, Some(msg)));
            }
            Ready::TimedOut => {
                // 잠금을 쥔 채 프로세스를 기다리지 않는다(메인 스레드의 상태 조회가 막히지 않게)
                let taken = lock(&self.inner).proc.take();
                if let Some(p) = taken {
                    p.stop(Duration::ZERO);
                }
                let msg = format!(
                    "서버가 {}초 안에 시작되지 않았습니다.\n{}",
                    READY_TIMEOUT.as_secs(),
                    log_tail(&log, 5)
                );
                self.set_status(app, generation, status(State::Failed, Some(msg)));
            }
            Ready::Superseded => {}
        }
    }

    fn spawn(
        &self,
        app: &AppHandle,
        settings: &Settings,
        generation: u64,
    ) -> Result<PathBuf, String> {
        if !port_free(settings.port) {
            return Err(format!(
                "포트 {} 을(를) 다른 프로그램이 쓰고 있습니다. 그 프로그램(따로 띄운 minmo-server 등)을 끄거나 서버 설정에서 포트를 바꾸세요.",
                settings.port
            ));
        }
        let dirs = profile::dirs(app)?;
        fs::create_dir_all(&dirs.data)
            .map_err(|e| format!("데이터 폴더를 만들 수 없습니다: {e}"))?;
        let launch = Launch {
            port: settings.port,
            db_path: dirs.data.join("minmo.db"),
            token_key: token_key()
                .map_err(|e| format!("키체인에서 서버 키를 준비하지 못했습니다: {e}"))?,
        };
        // 실패해도(항목 없음 포함) 시작에는 지장이 없다
        let _ = keychain::delete(LEGACY_CLIENT_SECRET_KEY);
        let exe = sidecar_path()?;
        if !exe.exists() {
            return Err(format!("서버 실행 파일이 없습니다: {}", exe.display()));
        }
        let (log_file, log) = open_log(&dirs.logs)?;
        let log_err = log_file.try_clone().map_err(|e| e.to_string())?;

        let (remove, set) = server_env(
            &launch,
            std::env::vars().map(|(k, _)| k),
            cfg!(debug_assertions),
        );
        let mut cmd = Command::new(&exe);
        for k in remove {
            cmd.env_remove(k);
        }
        cmd.envs(set)
            .current_dir(&dirs.data)
            .stdin(Stdio::piped())
            .stdout(Stdio::from(log_file))
            .stderr(Stdio::from(log_err));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(crate::commands::CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("서버를 실행할 수 없습니다: {e}"))?;
        let proc = Proc {
            stdin: child.stdin.take(),
            #[cfg(windows)]
            job: crate::commands::job::Job::for_process(child.id()),
            child,
            log: log.clone(),
        };
        let mut inner = lock(&self.inner);
        if inner.generation != generation {
            // 그사이 앱이 종료 중이면 바로 끈다
            drop(inner);
            proc.stop(Duration::ZERO);
            return Err("서버 시작이 취소되었습니다".to_string());
        }
        inner.proc = Some(proc);
        Ok(log)
    }

    fn wait_ready(&self, port: u16, generation: u64) -> Ready {
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            {
                let mut inner = lock(&self.inner);
                if inner.generation != generation {
                    return Ready::Superseded;
                }
                let Some(p) = inner.proc.as_mut() else {
                    return Ready::Superseded;
                };
                if let Ok(Some(code)) = p.child.try_wait() {
                    inner.proc = None;
                    return Ready::Exited(code.to_string());
                }
            }
            if accepting(port) {
                // 그사이 다른 프로그램이 포트를 잡아 서버가 bind 에 실패했다면 곧바로 끝난다 — 잠시 뒤 한 번 더 본다
                std::thread::sleep(Duration::from_millis(200));
                let mut inner = lock(&self.inner);
                if inner.generation != generation {
                    return Ready::Superseded;
                }
                return match inner.proc.as_mut().map(|p| p.child.try_wait()) {
                    Some(Ok(None)) => Ready::Yes,
                    Some(Ok(Some(code))) => {
                        inner.proc = None;
                        Ready::Exited(code.to_string())
                    }
                    _ => Ready::Superseded,
                };
            }
            if Instant::now() >= deadline {
                return Ready::TimedOut;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// 실행 중 서버가 끝나면 Failed 로 알린다(자동 재시작은 하지 않는다 — 화면의 [다시 시작])
    fn watch(&self, app: &AppHandle, generation: u64) {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(500));
            let mgr = app.state::<ServerManager>();
            let (code, log, port) = {
                let mut inner = lock(&mgr.inner);
                if inner.generation != generation {
                    return;
                }
                let Some(p) = inner.proc.as_mut() else { return };
                match p.child.try_wait() {
                    Ok(None) => continue,
                    Ok(Some(code)) => {
                        let log = p.log.clone();
                        inner.proc = None;
                        (code.to_string(), log, inner.settings.port)
                    }
                    Err(_) => return,
                }
            };
            let message = format!("서버가 종료되었습니다({code}).\n{}", log_tail(&log, 5));
            mgr.set_status(
                &app,
                generation,
                Status {
                    state: State::Failed,
                    port,
                    message: Some(message),
                },
            );
            return;
        });
    }

    pub fn view(&self) -> SettingsView {
        let (settings, warning) = {
            let inner = lock(&self.inner);
            (inner.settings.clone(), inner.warning.clone())
        };
        SettingsView {
            port: settings.port,
            close_action: settings.close_action,
            warning,
        }
    }

    fn persist(&self, app: &AppHandle, next: Settings) -> Result<(), String> {
        let dirs = profile::dirs(app)?;
        save_settings(&dirs.config.join(SETTINGS_FILE), &next)?;
        let mut inner = lock(&self.inner);
        inner.settings = next;
        inner.warning = None;
        Ok(())
    }

    /// 설정을 저장하고, 포트가 바뀌었으면 서버를 다시 시작한다
    pub fn save(&self, app: &AppHandle, input: SettingsInput) -> Result<SettingsView, String> {
        let current = self.settings();
        let mut next = current.clone();
        if let Some(port) = input.port {
            validate_port(port)?;
            next.port = port;
        }
        if let Some(action) = input.close_action {
            next.close_action = action;
        }
        self.persist(app, next.clone())?;
        if next.port != current.port {
            Self::restart(app);
        }
        Ok(self.view())
    }

    pub fn save_close_action(&self, app: &AppHandle, action: CloseAction) -> Result<(), String> {
        let mut next = self.settings();
        next.close_action = action;
        self.persist(app, next)
    }
}

fn publish(app: &AppHandle, status: &Status) {
    let _ = app.emit(STATUS_EVENT, status);
    crate::shell::set_tray_tooltip(app, status);
}

enum Ready {
    Yes,
    Exited(String),
    TimedOut,
    /// 그사이 정지·재시작됨
    Superseded,
}

#[tauri::command]
pub fn server_status(app: AppHandle) -> Status {
    app.state::<ServerManager>().status()
}

/// 키체인 접근(macOS 는 권한 확인 창)이 느릴 수 있어 읽기·저장 모두 async(메인 스레드 밖)로 둔다
#[tauri::command]
pub async fn server_settings_get(app: AppHandle) -> SettingsView {
    app.state::<ServerManager>().view()
}

#[tauri::command]
pub async fn server_settings_save(
    app: AppHandle,
    input: SettingsInput,
) -> Result<SettingsView, String> {
    app.state::<ServerManager>().save(&app, input)
}

#[tauri::command]
pub fn server_restart(app: AppHandle) {
    ServerManager::restart(&app);
}

#[tauri::command]
pub fn server_open_log_dir(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = profile::dirs(&app)?.logs;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir()
            .join("minmo-server-test")
            .join(format!("{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn settings_default_when_missing_and_roundtrip() {
        let d = tmp("roundtrip");
        let path = d.join("server.json");
        assert_eq!(load_settings(&path), (Settings::default(), None));

        let s = Settings {
            port: 18787,
            close_action: CloseAction::Tray,
        };
        save_settings(&path, &s).unwrap();
        assert_eq!(load_settings(&path), (s, None));
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"tray\""), "{text}");
    }

    #[test]
    fn broken_or_invalid_settings_fall_back_with_warning() {
        let d = tmp("broken");
        let path = d.join("server.json");
        fs::write(&path, "{not json").unwrap();
        let (s, w) = load_settings(&path);
        assert_eq!(s, Settings::default());
        assert!(w.unwrap().contains("형식"));

        fs::write(&path, r#"{"port":80,"githubClientId":"  id  "}"#).unwrap();
        let (s, w) = load_settings(&path);
        // 예전 버전이 남긴 값(githubClientId)은 무시한다
        assert_eq!(s.port, DEFAULT_PORT);
        assert!(w.unwrap().contains("1024"));

        // 모르는 값·빠진 키는 기본값
        fs::write(&path, r#"{"closeAction":"quit"}"#).unwrap();
        let (s, w) = load_settings(&path);
        assert_eq!(
            (s.port, s.close_action, w),
            (DEFAULT_PORT, CloseAction::Quit, None)
        );
    }

    #[test]
    fn port_validation() {
        assert!(validate_port(1023).is_err());
        assert!(validate_port(1024).is_ok());
        assert!(validate_port(65535).is_ok());
    }

    fn launch() -> Launch {
        Launch {
            port: 18787,
            db_path: PathBuf::from("data").join("minmo.db"),
            token_key: "k".into(),
        }
    }

    #[test]
    fn env_replaces_inherited_minmo_vars() {
        let inherited = [
            "PATH",
            "MINMO_ALLOW_NON_LOOPBACK",
            "minmo_listen",
            "MINMO_GITHUB_API_BASE",
            "MINMO_GITHUB_CLIENT_ID",
            "MINMO_GITHUB_CLIENT_SECRET",
        ]
        .map(String::from);
        let (remove, set) = server_env(&launch(), inherited.clone().into_iter(), false);
        assert_eq!(
            remove,
            [
                "MINMO_ALLOW_NON_LOOPBACK",
                "minmo_listen",
                "MINMO_GITHUB_API_BASE",
                "MINMO_GITHUB_CLIENT_ID",
                "MINMO_GITHUB_CLIENT_SECRET"
            ]
        );
        let get = |k: &str| {
            set.iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("MINMO_LISTEN"), Some("127.0.0.1:18787"));
        assert_eq!(get("MINMO_PUBLIC_URL"), Some("http://127.0.0.1:18787"));
        assert_eq!(get("MINMO_STOP_ON_STDIN_CLOSE"), Some("1"));
        // Client ID 는 서버에 들어 있는 값을 쓴다 — 앱이 넘기지 않는다
        assert!(set.iter().all(|(k, _)| !k.starts_with("MINMO_GITHUB_")));
        assert!(get("MINMO_DB_PATH").unwrap().ends_with("minmo.db"));

        // debug 빌드는 githubmock 용 주소·Client ID 만 통과(Secret 은 어디서도 쓰지 않는다)
        let (remove, _) = server_env(&launch(), inherited.into_iter(), true);
        assert_eq!(
            remove,
            [
                "MINMO_ALLOW_NON_LOOPBACK",
                "minmo_listen",
                "MINMO_GITHUB_CLIENT_SECRET"
            ]
        );
    }

    #[test]
    fn close_action_serde() {
        assert_eq!(
            serde_json::to_string(&CloseAction::Tray).unwrap(),
            "\"tray\""
        );
        let a: CloseAction = serde_json::from_str("\"ask\"").unwrap();
        assert_eq!(a, CloseAction::Ask);
        assert!(serde_json::from_str::<CloseAction>("\"minimize\"").is_err());
    }

    #[test]
    fn log_tail_keeps_last_lines() {
        let d = tmp("tail");
        let path = d.join("server.log");
        fs::write(&path, "a\n\nb\nc\nd\n").unwrap();
        assert_eq!(log_tail(&path, 2), "c\nd");
        assert_eq!(log_tail(&d.join("none.log"), 2), "");
    }

    #[test]
    fn open_log_rotates_previous() {
        let d = tmp("rotate");
        fs::write(d.join("server.log"), "old").unwrap();
        let (_f, log) = open_log(&d).unwrap();
        assert_eq!(
            fs::read_to_string(d.join("server.prev.log")).unwrap(),
            "old"
        );
        assert_eq!(fs::read_to_string(log).unwrap(), "");
    }
}
