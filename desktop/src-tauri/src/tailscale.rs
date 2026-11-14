// Tailscale 명령줄을 감싼다 — 설치 여부·로그인 상태 확인, 설치(패키지 관리자), 로그인, HTTPS(tailscale serve).
// 화면은 정해 둔 동작만 고른다: 실행할 프로그램이나 인자를 화면이 넘기지 못한다(붙은 기기는 이 명령들을 부를 수 없다 — remote.rs ALLOWED 에 없다).
// HTTPS 는 tailnet 안에서만 여는 `serve` 만 쓴다. 인터넷 전체에 여는 `funnel` 은 쓰지 않는다.
use std::io::Read;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::script::{kill_tree, ScriptRunResult};
use crate::remote::RemoteManager;

const DOWNLOAD_URL: &str = "https://tailscale.com/download";
/// 상태를 묻는 명령은 곧바로 끝난다 — 멈춘 경우에 화면이 같이 멈추지 않게 한다
const QUICK: Duration = Duration::from_secs(5);
/// tailnet 에서 HTTPS 가 꺼져 있으면 `serve` 는 켜는 주소를 찍고 켜질 때까지 기다린다 — 그 주소만 받고 끝낸다
const SERVE_WAIT: Duration = Duration::from_secs(12);
const LOGIN_WAIT: Duration = Duration::from_secs(15);
/// 로그인을 끝내지 않은 `tailscale up` 을 남겨 두지 않는다
const LOGIN_KEEP: Duration = Duration::from_secs(600);
const HTTPS_PORT: &str = "443";

#[derive(Default)]
pub struct TailscaleState {
    /// 로그인을 기다리는 `tailscale up`
    login: Mutex<Option<Child>>,
    /// 설치 중인 패키지 관리자의 pid
    install: Mutex<Option<u32>>,
    install_cancelled: AtomicBool,
    /// 로그인 주소를 기다리는 중(두 번 누르거나 창을 닫았다 열어도 하나만 돈다)
    login_busy: AtomicBool,
    /// HTTPS 를 켜고 끄는 일은 한 번에 하나씩(포트를 연달아 바꿔도 마지막 설정으로 끝나게)
    serve_lock: Mutex<()>,
}

fn command(exe: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::commands::CREATE_NO_WINDOW);
    }
    cmd
}

struct Out {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

impl Out {
    fn ok(&self) -> bool {
        self.code == Some(0) && !self.timed_out
    }

    fn text(&self) -> String {
        format!("{}\n{}", self.stdout.trim(), self.stderr.trim())
            .trim()
            .to_string()
    }
}

fn drain<R: Read + Send + 'static>(r: Option<R>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = r {
            let _ = r.read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    })
}

/// 끝날 때까지(또는 timeout 까지) 기다린다. timeout 이면 끝내고 그때까지의 출력을 돌려준다
fn run(exe: &Path, args: &[&str], timeout: Duration) -> std::io::Result<Out> {
    let mut child = command(exe, args).spawn()?;
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let start = Instant::now();
    let (code, timed_out) = loop {
        match child.try_wait()? {
            Some(st) => break (st.code(), false),
            None if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                break (None, true);
            }
            None => std::thread::sleep(Duration::from_millis(40)),
        }
    };
    Ok(Out {
        code,
        timed_out,
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

fn candidates() -> Vec<PathBuf> {
    // 정해진 설치 위치를 먼저 본다 — PATH 의 다른 폴더에 놓인 같은 이름의 파일이 앞서지 않게
    let mut list: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        list.push(r"C:\Program Files\Tailscale\tailscale.exe".into());
    } else if cfg!(target_os = "macos") {
        // GUI 앱의 PATH 에는 Homebrew 경로가 없다
        list.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale".into());
        list.push("/opt/homebrew/bin/tailscale".into());
        list.push("/usr/local/bin/tailscale".into());
    }
    list.push("tailscale".into());
    list
}

static EXE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// tailscale 실행 파일(없으면 None). 찾은 것만 기억한다 — 없던 것은 방금 설치했을 수 있다
pub fn exe() -> Option<PathBuf> {
    if let Ok(c) = EXE.lock() {
        if let Some(p) = c.as_ref() {
            return Some(p.clone());
        }
    }
    let found = candidates()
        .into_iter()
        .find(|c| run(c, &["version"], QUICK).is_ok_and(|o| o.ok()))?;
    if let Ok(mut c) = EXE.lock() {
        *c = Some(found.clone());
    }
    Some(found)
}

fn forget_exe() {
    if let Ok(mut c) = EXE.lock() {
        *c = None;
    }
}

static IP_CACHE: Mutex<Option<(Instant, Vec<Ipv4Addr>)>> = Mutex::new(None);

/// 기억해 둔 주소와 달라졌으면 true
fn remember_ips(list: &[Ipv4Addr]) -> bool {
    let Ok(mut c) = IP_CACHE.lock() else {
        return false;
    };
    let changed = !matches!(c.as_ref(), Some((_, old)) if old == list);
    *c = Some((Instant::now(), list.to_vec()));
    changed
}

/// `tailscale ip -4` 가 알려 주는 이 PC 의 Tailscale 주소(없거나 실행할 수 없으면 빈 목록). 잠깐 기억해 둔다
pub fn ip4() -> Vec<Ipv4Addr> {
    if let Ok(c) = IP_CACHE.lock() {
        if let Some((at, list)) = c.as_ref() {
            if at.elapsed() < Duration::from_secs(60) {
                return list.clone();
            }
        }
    }
    let list = exe()
        .and_then(|exe| run(&exe, &["ip", "-4"], QUICK).ok())
        .filter(Out::ok)
        .map(|o| {
            o.stdout
                .lines()
                .filter_map(|l| l.trim().parse().ok())
                .collect::<Vec<Ipv4Addr>>()
        })
        .unwrap_or_default();
    remember_ips(&list);
    list
}

#[derive(Debug, Default, PartialEq)]
struct Backend {
    state: &'static str,
    name: Option<String>,
    ips: Vec<Ipv4Addr>,
    auth_url: Option<String>,
}

fn non_empty(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// `tailscale status --json` (ipnstate.Status) 에서 쓰는 것만 읽는다
fn parse_status(text: &str) -> Option<Backend> {
    let v: Value = serde_json::from_str(text).ok()?;
    let state = match v.get("BackendState")?.as_str()? {
        "Running" => "running",
        "Starting" | "NoState" => "starting",
        "Stopped" => "stopped",
        "NeedsLogin" => "needs-login",
        // tailnet 관리자가 이 기기를 승인해야 한다
        "NeedsMachineAuth" => "needs-approval",
        _ => "unknown",
    };
    let me = v.get("Self");
    let name = non_empty(me.and_then(|m| m.get("DNSName")))
        .map(|n| n.trim_end_matches('.').to_string())
        .or_else(|| non_empty(me.and_then(|m| m.get("HostName"))));
    let ips = me
        .and_then(|m| m.get("TailscaleIPs"))
        .or_else(|| v.get("TailscaleIPs"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|ip| ip.as_str()?.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    Some(Backend {
        state,
        name,
        ips,
        auth_url: non_empty(v.get("AuthURL")).filter(|u| u.starts_with("https://")),
    })
}

#[derive(Debug, Default, PartialEq)]
struct Serve {
    /// 443 이 minmo 의 포트만 가리킬 때: 주소와 그 포트
    mine: Option<(String, u16)>,
    /// 443 에 다른 설정이 있다 — 건드리지 않는다
    conflict: bool,
}

impl Serve {
    /// 지금의 원격 접속 포트를 가리킬 때만 쓸 수 있는 주소다
    fn url_for(&self, port: u16) -> Option<String> {
        self.mine
            .as_ref()
            .filter(|(_, p)| *p == port)
            .map(|(url, _)| url.clone())
    }
}

fn is_ours(proxy: &str, port: u16) -> bool {
    let p = proxy.trim_end_matches('/');
    p == format!("http://127.0.0.1:{port}") || p == format!("http://localhost:{port}")
}

fn dns_name_ok(host: &str) -> bool {
    !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}

/// `tailscale serve status --json` (ipn.ServeConfig). 443 의 "/" 하나가 ports(지금의 원격 접속 포트, 그리고 minmo 가
/// 마지막으로 걸어 둔 포트) 중 하나를 가리킬 때만 minmo 의 것으로 본다 — 사용자가 따로 걸어 둔 설정(다른 경로·다른 대상,
/// 인터넷에 여는 funnel)은 켜거나 끌 때 지워지지 않게 그대로 둔다.
fn parse_serve(text: &str, ports: &[u16]) -> Serve {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return Serve::default();
    };
    let mut mine = None;
    let mut foreign = false;
    let funnel = |hostport: &str| {
        v.get("AllowFunnel")
            .and_then(|f| f.get(hostport))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let mut used = v
        .get("TCP")
        .and_then(Value::as_object)
        .is_some_and(|tcp| tcp.contains_key(HTTPS_PORT));
    if let Some(web) = v.get("Web").and_then(Value::as_object) {
        for (hostport, cfg) in web {
            let Some((host, p)) = hostport.rsplit_once(':') else {
                continue;
            };
            if p != HTTPS_PORT {
                continue;
            }
            used = true;
            let handlers = cfg.get("Handlers").and_then(Value::as_object);
            let port = handlers.filter(|h| h.len() == 1).and_then(|h| {
                let proxy = h.get("/")?.get("Proxy")?.as_str()?;
                ports.iter().copied().find(|p| is_ours(proxy, *p))
            });
            match port {
                Some(port) if dns_name_ok(host) && !funnel(hostport) && mine.is_none() => {
                    mine = Some((format!("https://{host}"), port));
                }
                _ => foreign = true,
            }
        }
    }
    if foreign {
        mine = None;
    }
    Serve {
        conflict: used && mine.is_none(),
        mine,
    }
}

/// minmo 가 마지막으로 HTTPS 를 걸어 둔 포트(설정 폴더의 tailscale.json). 원격 접속 포트가 바뀐 뒤에도
/// 그 설정이 minmo 의 것임을 알아보는 데 쓴다 — Tailscale 이 꺼져 있어 따라가지 못한 경우에도 다시 맞출 수 있다
fn record_path(app: &AppHandle) -> Option<PathBuf> {
    Some(
        crate::profile::dirs(app)
            .ok()?
            .config
            .join("tailscale.json"),
    )
}

fn recorded_port(app: &AppHandle) -> Option<u16> {
    let text = std::fs::read_to_string(record_path(app)?).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    u16::try_from(v.get("servePort")?.as_u64()?).ok()
}

fn record_port(app: &AppHandle, port: Option<u16>) {
    let Some(path) = record_path(app) else {
        return;
    };
    let _ = match port {
        Some(p) => std::fs::write(path, format!(r#"{{"servePort":{p}}}"#)),
        None => std::fs::remove_file(path),
    };
}

fn ports_of(app: &AppHandle, port: u16) -> Vec<u16> {
    let mut ports = vec![port];
    ports.extend(recorded_port(app).filter(|p| *p != port));
    ports
}

/// 출력에서 처음 나오는 https 주소(로그인 주소·HTTPS 를 켜는 주소)
fn find_url(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|w| w.starts_with("https://") && w.len() > "https://".len())
        .map(|w| w.trim_end_matches(['.', ',', ')']).to_string())
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    /// 화면에 그대로 보여 주는 명령(없으면 설치 페이지로 안내한다)
    command: Option<String>,
    /// 앱이 이 명령을 대신 실행할 수 있는가
    auto: bool,
    download_url: &'static str,
    #[serde(skip)]
    program: Option<PathBuf>,
    #[serde(skip)]
    args: Vec<&'static str>,
}

const WINGET_ARGS: &[&str] = &[
    "install",
    "--id",
    "Tailscale.Tailscale",
    "-e",
    "--source",
    "winget",
    // 입력을 받을 수 없으므로(창 없이 실행) 동의를 묻는 단계에서 멈추지 않게 한다 — 화면이 이 명령을 그대로 보여 준다
    "--accept-source-agreements",
    "--accept-package-agreements",
];

/// 설치는 OS 의 패키지 관리자에 맡긴다(출처·서명 확인을 그쪽이 한다).
/// macOS(Homebrew 가 .pkg 를 설치한다)와 Linux 는 관리자 암호를 물으므로 앱이 대신 실행하지 않고 명령만 안내한다.
fn install_plan(os: &str, winget: bool, brew: bool) -> InstallPlan {
    let manual = |command: Option<&str>| InstallPlan {
        command: command.map(str::to_string),
        auto: false,
        download_url: DOWNLOAD_URL,
        program: None,
        args: Vec::new(),
    };
    let auto = |program: PathBuf, shown: &str, args: &'static [&'static str]| InstallPlan {
        command: Some(format!("{shown} {}", args.join(" "))),
        auto: true,
        download_url: DOWNLOAD_URL,
        program: Some(program),
        args: args.to_vec(),
    };
    match os {
        "windows" if winget => auto("winget".into(), "winget", WINGET_ARGS),
        "macos" if brew => manual(Some("brew install --cask tailscale-app")),
        "linux" => manual(Some("curl -fsSL https://tailscale.com/install.sh | sh")),
        _ => manual(None),
    }
}

fn current_plan() -> InstallPlan {
    static WINGET: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
    let winget = cfg!(windows) && {
        let cached = WINGET
            .lock()
            .ok()
            .and_then(|c| c.filter(|(at, _)| at.elapsed() < Duration::from_secs(60)));
        match cached {
            Some((_, has)) => has,
            None => {
                let has = run(Path::new("winget"), &["--version"], QUICK).is_ok_and(|o| o.ok());
                if let Ok(mut c) = WINGET.lock() {
                    *c = Some((Instant::now(), has));
                }
                has
            }
        }
    };
    let brew = cfg!(target_os = "macos")
        && ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
            .iter()
            .any(|p| Path::new(p).exists());
    install_plan(std::env::consts::OS, winget, brew)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// missing · needs-login · needs-approval · stopped · starting · running · unknown · unavailable(서비스가 답하지 않음)
    state: &'static str,
    /// 이 PC 의 tailnet 이름(연결됐을 때)
    name: Option<String>,
    ips: Vec<String>,
    /// tailnet 안에서 여는 HTTPS 주소(켜져 있을 때)
    https_url: Option<String>,
    /// 443 에 사용자가 따로 건 `tailscale serve` 설정이 있다
    https_conflict: bool,
    /// 설치되지 않았을 때의 설치 방법
    install: Option<InstallPlan>,
    /// 설치 명령이 돌고 있다(창을 닫았다 다시 열어도 알 수 있게)
    installing: bool,
    error: Option<String>,
}

fn status(app: &AppHandle) -> Status {
    let mgr = app.state::<RemoteManager>();
    let port = mgr.port();
    let state = app.state::<TailscaleState>();
    // 로그인이 끝나 스스로 종료한 `tailscale up` 을 거둔다
    if let Ok(mut slot) = state.login.lock() {
        if slot
            .as_mut()
            .is_some_and(|c| !matches!(c.try_wait(), Ok(None)))
        {
            *slot = None;
        }
    }
    let mut st = Status {
        installing: state.install.lock().is_ok_and(|s| s.is_some()),
        state: "missing",
        name: None,
        ips: Vec::new(),
        https_url: None,
        https_conflict: false,
        install: None,
        error: None,
    };
    let Some(exe) = exe() else {
        st.install = Some(current_plan());
        return st;
    };
    let out = match run(&exe, &["status", "--json"], QUICK) {
        Ok(out) => out,
        Err(_) => {
            // 지워졌다 — 다음에 다시 찾는다
            forget_exe();
            st.install = Some(current_plan());
            return st;
        }
    };
    let Some(backend) = parse_status(&out.stdout) else {
        st.state = "unavailable";
        st.error = Some(out.text()).filter(|t| !t.is_empty());
        return st;
    };
    st.state = backend.state;
    if backend.state != "running" {
        return st;
    }
    // 방금 연결됐으면(주소가 달라졌으면) 원격 접속이 이 주소에도 바로 연다
    if remember_ips(&backend.ips) {
        mgr.reconcile(app);
    }
    st.name = backend.name;
    st.ips = backend.ips.iter().map(Ipv4Addr::to_string).collect();
    if let Ok(out) = run(&exe, &["serve", "status", "--json"], QUICK) {
        let serve = parse_serve(&out.stdout, &ports_of(app, port));
        st.https_url = serve.url_for(port);
        st.https_conflict = serve.conflict;
    }
    st
}

fn serve_on(exe: &Path, port: u16) -> Result<Option<String>, String> {
    let target = format!("http://127.0.0.1:{port}");
    let https = format!("--https={HTTPS_PORT}");
    let out =
        run(exe, &["serve", "--bg", &https, &target], SERVE_WAIT).map_err(|e| e.to_string())?;
    if out.ok() {
        return Ok(None);
    }
    let text = out.text();
    // tailnet 에서 HTTPS 가 꺼져 있으면 켜는 주소를 알려 준다("... not enabled ... To enable, visit: <주소>").
    // 다른 오류에 섞인 주소를 그 안내로 보지 않는다
    if text.to_ascii_lowercase().contains("enable") {
        if let Some(url) = find_url(&text) {
            return Ok(Some(url));
        }
    }
    Err(if text.is_empty() {
        "tailscale serve 가 끝나지 않았습니다".to_string()
    } else {
        text
    })
}

fn serve_off(exe: &Path) -> Result<(), String> {
    let https = format!("--https={HTTPS_PORT}");
    let out = run(exe, &["serve", &https, "off"], QUICK).map_err(|e| e.to_string())?;
    if out.ok() {
        Ok(())
    } else {
        Err(out.text())
    }
}

/// 원격 접속을 끄거나 포트를 바꾼 뒤 HTTPS 를 맞춘다(끄면 끄고, 포트가 바뀌었으면 새 포트로). minmo 가 건 설정일 때만 건드린다.
/// 넘겨받은 값이 아니라 그때의 설정을 읽어 맞추므로, 연달아 바꿔도 마지막 설정으로 끝난다.
/// Tailscale 이 꺼져 있어 맞추지 못하면 그대로 두고, 화면이 [HTTPS 로 열기] 를 다시 내보인다.
pub fn follow_remote(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<TailscaleState>();
        let Ok(_guard) = state.serve_lock.lock() else {
            return;
        };
        let Some(exe) = exe() else {
            return;
        };
        let mgr = app.state::<RemoteManager>();
        let (enabled, port) = (mgr.enabled(), mgr.port());
        let Ok(out) = run(&exe, &["serve", "status", "--json"], QUICK) else {
            return;
        };
        let Some((_, current)) = parse_serve(&out.stdout, &ports_of(&app, port)).mine else {
            return;
        };
        if !enabled {
            if serve_off(&exe).is_ok() {
                record_port(&app, None);
            }
        } else if current != port && matches!(serve_on(&exe, port), Ok(None)) {
            record_port(&app, Some(port));
        }
    });
}

/// 앱을 끝낼 때: 로그인을 기다리던 `tailscale up` 을 남기지 않는다
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<TailscaleState>() {
        if let Ok(mut slot) = state.login.lock() {
            stop(slot.take());
        }
    }
}

fn stop(child: Option<Child>) {
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// `tailscale up` 을 시작해 로그인 주소를 돌려준다(이미 로그인돼 있어 바로 연결되면 None).
/// 로그인이 끝나야 명령이 끝나므로 주소가 나오면 띄워 둔 채 돌아간다.
fn login(app: &AppHandle, exe: &Path) -> Result<Option<String>, String> {
    let state = app.state::<TailscaleState>();
    stop(state.login.lock().map_err(|e| e.to_string())?.take());
    let mut child = command(exe, &["up"])
        .spawn()
        .map_err(|e| format!("tailscale 실행 실패: {e}"))?;
    let (tx, rx) = mpsc::channel::<String>();
    let mut readers: Vec<Box<dyn Read + Send>> = Vec::new();
    if let Some(s) = child.stdout.take() {
        readers.push(Box::new(s));
    }
    if let Some(s) = child.stderr.take() {
        readers.push(Box::new(s));
    }
    for r in readers {
        let tx = tx.clone();
        // 주소를 받은 뒤에도 끝까지 읽어 준다 — 파이프가 차서 명령이 멈추지 않게
        std::thread::spawn(move || {
            pump_lines(r, |line, _| {
                let _ = tx.send(line);
            })
        });
    }
    drop(tx);

    let keep = |child: Child| {
        let pid = child.id();
        if let Ok(mut slot) = state.login.lock() {
            *slot = Some(child);
        }
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(LOGIN_KEEP);
            if let Ok(mut slot) = app.state::<TailscaleState>().login.lock() {
                if slot.as_ref().is_some_and(|c| c.id() == pid) {
                    stop(slot.take());
                }
            }
        });
    };

    let start = Instant::now();
    let mut seen = String::new();
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                if let Some(url) = find_url(&line) {
                    keep(child);
                    return Ok(Some(url));
                }
                seen.push_str(&line);
                seen.push('\n');
            }
            Err(RecvTimeoutError::Timeout) if start.elapsed() < LOGIN_WAIT => {}
            Err(RecvTimeoutError::Timeout) => {
                // 주소를 찍지 않고 기다리는 중 — 서비스가 알고 있는 로그인 주소가 있으면 그것을 쓴다
                keep(child);
                return Ok(run(exe, &["status", "--json"], QUICK)
                    .ok()
                    .and_then(|o| parse_status(&o.stdout))
                    .and_then(|b| b.auth_url));
            }
            // 출력이 모두 닫혔다 = 명령이 끝났다
            Err(RecvTimeoutError::Disconnected) => {
                let ok = child.wait().is_ok_and(|s| s.success());
                return if ok {
                    Ok(None)
                } else {
                    Err(Some(seen.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "tailscale up 이 실패했습니다".to_string()))
                };
            }
        }
    }
}

/// 진행 막대처럼 같은 줄을 덮어쓰는 출력(\r)도 줄로 나눈다. 두 번째 값은 덮어쓰는 줄(진행 막대)인지
fn pump_lines<R: Read>(mut r: R, mut emit: impl FnMut(String, bool)) {
    let mut pending = Vec::new();
    let mut buf = [0u8; 4096];
    let mut flush = |bytes: &mut Vec<u8>| {
        let line = String::from_utf8_lossy(bytes).trim().to_string();
        bytes.clear();
        // 돌아가는 막대(- \ | /)만 있는 줄은 버린다
        if line
            .chars()
            .all(|c| matches!(c, '-' | '\\' | '|' | '/' | ' '))
        {
            return;
        }
        let transient = line.contains(['█', '▒']);
        emit(line, transient);
    };
    loop {
        match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for b in &buf[..n] {
                    if *b == b'\n' || *b == b'\r' {
                        flush(&mut pending);
                    } else {
                        pending.push(*b);
                    }
                }
            }
        }
    }
    flush(&mut pending);
}

#[derive(Clone, Serialize)]
struct LogLine {
    line: String,
    transient: bool,
}

#[tauri::command]
pub async fn tailscale_status(app: AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || status(&app))
        .await
        .map_err(|e| e.to_string())
}

/// 정해 둔 설치 명령을 실행하고 출력을 tailscale-log 로 흘린다
#[tauri::command]
pub async fn tailscale_install(app: AppHandle) -> Result<ScriptRunResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if exe().is_some() {
            return Err("Tailscale 이 이미 설치되어 있습니다".to_string());
        }
        let plan = current_plan();
        let Some(program) = plan.program.filter(|_| plan.auto) else {
            return Err(
                "이 PC 에서는 앱이 대신 설치할 수 없습니다 — 설치 페이지를 이용하세요".into(),
            );
        };
        let state = app.state::<TailscaleState>();
        let mut child = {
            // 확인과 시작을 한 잠금 안에서 — 두 번 눌러도 하나만 돈다
            let mut slot = state.install.lock().map_err(|e| e.to_string())?;
            if slot.is_some() {
                return Err("이미 설치하고 있습니다".into());
            }
            let mut cmd = command(&program, &plan.args);
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                // 취소할 때 자식까지 한 번에 끝내도록 새 프로세스 그룹
                cmd.process_group(0);
            }
            let child = cmd
                .spawn()
                .map_err(|e| format!("설치 명령 실행 실패: {e}"))?;
            *slot = Some(child.id());
            state.install_cancelled.store(false, Ordering::SeqCst);
            child
        };
        let mut streams: Vec<Box<dyn Read + Send>> = Vec::new();
        if let Some(s) = child.stdout.take() {
            streams.push(Box::new(s));
        }
        if let Some(s) = child.stderr.take() {
            streams.push(Box::new(s));
        }
        for s in streams {
            let app = app.clone();
            // 끝까지 기다리지 않는다 — 설치 프로그램이 띄운 프로세스가 출력 통로를 물고 있으면 끝나지 않는다
            std::thread::spawn(move || {
                pump_lines(s, |line, transient| {
                    let _ = app.emit("tailscale-log", LogLine { line, transient });
                })
            });
        }
        let waited = child.wait();
        if let Ok(mut slot) = state.install.lock() {
            *slot = None;
        }
        if state.install_cancelled.swap(false, Ordering::SeqCst) {
            return Ok(ScriptRunResult::cancelled());
        }
        let code = waited.map_err(|e| e.to_string())?.code().unwrap_or(-1);
        Ok(ScriptRunResult::exited(code))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn tailscale_install_cancel(app: AppHandle) -> Result<(), String> {
    let state = app.state::<TailscaleState>();
    let pid = *state.install.lock().map_err(|e| e.to_string())?;
    if let Some(pid) = pid {
        state.install_cancelled.store(true, Ordering::SeqCst);
        kill_tree(pid);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    /// 브라우저로 열 로그인 주소(이미 로그인돼 있어 바로 연결됐으면 없다)
    url: Option<String>,
}

#[tauri::command]
pub async fn tailscale_login(app: AppHandle) -> Result<LoginStart, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe = exe().ok_or("Tailscale 이 설치되어 있지 않습니다")?;
        let state = app.state::<TailscaleState>();
        if state.login_busy.swap(true, Ordering::SeqCst) {
            return Err("이미 로그인을 시작하고 있습니다".to_string());
        }
        let url = login(&app, &exe);
        state.login_busy.store(false, Ordering::SeqCst);
        Ok(LoginStart { url: url? })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServeResult {
    status: Status,
    /// tailnet 에서 HTTPS 가 꺼져 있을 때: 켜는 주소(Tailscale 관리 화면)
    enable_url: Option<String>,
}

#[tauri::command]
pub async fn tailscale_serve(app: AppHandle, on: bool) -> Result<ServeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<RemoteManager>();
        let port = mgr.port();
        let exe = exe().ok_or("Tailscale 이 설치되어 있지 않습니다")?;
        let state = app.state::<TailscaleState>();
        let _guard = state.serve_lock.lock().map_err(|e| e.to_string())?;
        let now = status(&app);
        let mut enable_url = None;
        if on {
            if !mgr.enabled() {
                return Err("원격 접속을 먼저 켜세요".to_string());
            }
            if now.state != "running" {
                return Err("Tailscale 에 연결되어 있지 않습니다".into());
            }
            if now.https_conflict {
                return Err("이 PC 의 443 포트에 이미 다른 tailscale serve 설정이 있습니다 — 그 설정을 지우지 않도록 그대로 두었습니다".into());
            }
            if now.https_url.is_none() {
                enable_url = serve_on(&exe, port)?;
            }
            if enable_url.is_none() {
                record_port(&app, Some(port));
            }
        } else if now.https_url.is_some() {
            // minmo 가 건 설정일 때만 끈다
            serve_off(&exe)?;
            record_port(&app, None);
        }
        Ok(ServeResult {
            status: status(&app),
            enable_url,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_backend_state_name_and_addresses() {
        let running = r#"{"BackendState":"Running","AuthURL":"","TailscaleIPs":["100.101.102.103","fd7a:115c:a1e0::1"],
            "Self":{"HostName":"my-pc","DNSName":"my-pc.tail1234.ts.net.","TailscaleIPs":["100.101.102.103","fd7a:115c:a1e0::1"],"Online":true}}"#;
        assert_eq!(
            parse_status(running),
            Some(Backend {
                state: "running",
                name: Some("my-pc.tail1234.ts.net".into()),
                ips: vec![Ipv4Addr::new(100, 101, 102, 103)],
                auth_url: None,
            })
        );
        let login = r#"{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/abc123","Self":{"HostName":"my-pc","DNSName":""}}"#;
        let b = parse_status(login).unwrap();
        assert_eq!(b.state, "needs-login");
        assert_eq!(
            b.auth_url.as_deref(),
            Some("https://login.tailscale.com/a/abc123")
        );
        assert_eq!(b.name.as_deref(), Some("my-pc"));
        for (raw, want) in [
            ("Stopped", "stopped"),
            ("Starting", "starting"),
            ("NoState", "starting"),
            ("NeedsMachineAuth", "needs-approval"),
            ("SomethingNew", "unknown"),
        ] {
            let json = format!(r#"{{"BackendState":"{raw}"}}"#);
            assert_eq!(parse_status(&json).unwrap().state, want, "{raw}");
        }
        // 서비스가 답하지 않으면 JSON 이 아니다
        assert_eq!(parse_status("failed to connect to local tailscaled"), None);
        assert_eq!(parse_status("{}"), None);
        // 로그인 주소는 https 만 받는다
        let odd = r#"{"BackendState":"NeedsLogin","AuthURL":"javascript:alert(1)"}"#;
        assert_eq!(parse_status(odd).unwrap().auth_url, None);
    }

    #[test]
    fn https_is_ours_only_when_443_points_at_this_port_alone() {
        let ours = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"my-pc.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8790"}}}}}"#;
        let mine = Serve {
            mine: Some(("https://my-pc.tail1234.ts.net".into(), 8790)),
            conflict: false,
        };
        assert_eq!(parse_serve(ours, &[8790]), mine);
        assert_eq!(
            mine.url_for(8790).as_deref(),
            Some("https://my-pc.tail1234.ts.net")
        );
        // 다른 포트를 가리킨다 = 사용자가 건 설정
        let conflict = Serve {
            mine: None,
            conflict: true,
        };
        assert_eq!(parse_serve(ours, &[9000]), conflict);
        // minmo 가 걸어 둔 포트(기록)를 가리키면 포트를 바꾼 뒤에도 minmo 의 것이다 — 다만 지금 쓸 주소는 아니다
        let stale = parse_serve(ours, &[9000, 8790]);
        assert_eq!(stale, mine);
        assert_eq!(stale.url_for(9000), None);
        // 인터넷에 열려 있으면(funnel) "tailnet 안에서만"이라고 할 수 없다 — 사용자의 설정으로 본다
        let funnel = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"my-pc.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8790"}}}},"AllowFunnel":{"my-pc.tail1234.ts.net:443":true}}"#;
        assert_eq!(parse_serve(funnel, &[8790]), conflict);
        // 443 에 이름이 여럿이고 하나라도 다른 설정이면 건드리지 않는다
        let two = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"my-pc.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8790"}}},"svc.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}"#;
        assert_eq!(parse_serve(two, &[8790]), conflict);
        // 다른 경로가 함께 걸려 있으면 끌 때 같이 지워질 수 있으므로 건드리지 않는다
        let shared = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"my-pc.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8790"},"/docs":{"Path":"/srv/docs"}}}}}"#;
        assert_eq!(parse_serve(shared, &[8790]), conflict);
        // 443 을 TCP 로 넘기는 설정
        let tcp = r#"{"TCP":{"443":{"TCPForward":"127.0.0.1:5432"}}}"#;
        assert!(parse_serve(tcp, &[8790]).conflict);
        // 다른 포트의 설정은 상관없다
        let other = r#"{"TCP":{"8443":{"HTTPS":true}},"Web":{"my-pc.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}"#;
        assert_eq!(parse_serve(other, &[8790]), Serve::default());
        for empty in ["{}", "", "null", "not json"] {
            assert_eq!(parse_serve(empty, &[8790]), Serve::default(), "{empty}");
        }
        assert!(is_ours("http://localhost:8790/", 8790));
        assert!(!is_ours("http://127.0.0.1:87900", 8790));
        assert!(!is_ours("https+insecure://127.0.0.1:8790", 8790));
        // 주소에 넣을 수 없는 이름은 쓰지 않는다
        let odd = r#"{"Web":{"evil.example/#x:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8790"}}}}}"#;
        assert_eq!(parse_serve(odd, &[8790]).mine, None);
    }

    #[test]
    fn install_uses_only_the_fixed_package_manager_commands() {
        let win = install_plan("windows", true, false);
        assert!(win.auto);
        assert_eq!(win.program.as_deref(), Some(Path::new("winget")));
        assert_eq!(
            win.command.as_deref(),
            Some("winget install --id Tailscale.Tailscale -e --source winget --accept-source-agreements --accept-package-agreements")
        );
        // 화면에 보여 주는 명령과 실제로 실행하는 인자가 같다
        assert_eq!(
            win.command.unwrap(),
            format!("winget {}", win.args.join(" "))
        );

        let no_winget = install_plan("windows", false, false);
        assert!(!no_winget.auto && no_winget.command.is_none() && no_winget.program.is_none());

        // macOS·Linux 는 관리자 암호가 필요하다 — 명령만 보여 주고 실행하지 않는다
        let mac = install_plan("macos", false, true);
        assert!(!mac.auto && mac.program.is_none());
        assert_eq!(
            mac.command.as_deref(),
            Some("brew install --cask tailscale-app")
        );
        assert_eq!(install_plan("macos", false, false).command, None);
        let linux = install_plan("linux", false, false);
        assert!(!linux.auto && linux.program.is_none());
        assert!(linux.command.unwrap().contains("tailscale.com/install.sh"));
        assert_eq!(linux.download_url, "https://tailscale.com/download");
    }

    #[test]
    fn finds_the_url_in_command_output() {
        assert_eq!(
            find_url("\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/1a2b3c\n")
                .as_deref(),
            Some("https://login.tailscale.com/a/1a2b3c")
        );
        assert_eq!(
            find_url("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=n123.").as_deref(),
            Some("https://login.tailscale.com/f/serve?node=n123")
        );
        assert_eq!(find_url("Success."), None);
        assert_eq!(find_url("see https://"), None);
    }

    #[test]
    fn splits_overwritten_progress_into_lines() {
        let raw = "  -\r  \\\r  |\rFound Tailscale [Tailscale.Tailscale]\r\n  ██▒▒▒▒  1.0 MB / 30 MB\r  ████▒▒  20 MB / 30 MB\rSuccessfully installed\n한글 줄";
        let mut got = Vec::new();
        pump_lines(raw.as_bytes(), |line, transient| {
            got.push((line, transient))
        });
        assert_eq!(
            got,
            vec![
                ("Found Tailscale [Tailscale.Tailscale]".to_string(), false),
                ("██▒▒▒▒  1.0 MB / 30 MB".to_string(), true),
                ("████▒▒  20 MB / 30 MB".to_string(), true),
                ("Successfully installed".to_string(), false),
                ("한글 줄".to_string(), false),
            ]
        );
    }
}
