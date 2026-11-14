// 원격 접속(호스트 모드) — 다른 PC·휴대폰의 브라우저가 이 앱에 붙어 같은 화면을 쓴다.
//
// 앱 안에 작은 HTTP + WebSocket 서버를 띄운다(기본은 꺼짐). 하는 일:
//   /            웹 화면(앱에 들어 있는 것과 같은 파일)
//   /pair        기기 등록 — 이 PC 화면에 띄운 6자리 코드로 기기 토큰을 받는다
//   /ws          화면의 네이티브 호출(TauriApi)과 이벤트(터미널 출력 등)
//   /api, /gh    이 PC 의 minmo 서버와 GitHub API 로 대신 요청(세션·GitHub 토큰은 이 PC 밖으로 나가지 않는다)
//
// 원격 접속은 이 PC 를 터미널로 조작할 수 있는 권한이다. 그래서 등록한 기기만 받고, 공개 인터넷 주소에는 열지 않는다
// (Tailscale 주소와 127.0.0.1, 사용자가 따로 켠 경우에만 사설 LAN 주소).
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State as AxState};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::{broadcast, oneshot};

use crate::commands::{keychain, pty};
use crate::{profile, server};

pub const DEFAULT_PORT: u16 = 8790;
/// 원격 화면이 GitHub 토큰 자리에 넣어 보내는 표식 — 이 PC 에서 실제 토큰으로 바꾼다(토큰을 내보내지 않는다)
pub const TOKEN_SENTINEL: &str = "__MINMO_HOST_GITHUB_TOKEN__";
const DEVICE_HEADER: &str = "x-minmo-device";
const PAIR_TTL: Duration = Duration::from_secs(120);
const PAIR_MAX_FAILS: u32 = 5;
/// 화면(웹뷰)에 맡긴 호출을 기다리는 상한 — git fetch·스크립트처럼 오래 걸리는 것이 있다
const RPC_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_BODY: usize = 8 * 1024 * 1024;

/// 원격에서 부를 수 있는 호출(TauriApi 의 메서드 이름). 이 PC 의 화면·보안에 관한 것(키체인, 서버 설정, 앱 종료·업데이트,
/// 폴더 열기·선택 창, 알림, ssh 호스트 등록)은 넣지 않는다.
const ALLOWED: &[&str] = &[
    "gitRun",
    "ghRun",
    "ghAvailable",
    "ptySpawn",
    "ptyFind",
    "ptyWrite",
    "ptyResize",
    "ptyKill",
    "ptyKillByCwd",
    "ptyList",
    "ptyProcesses",
    "claudeSubagents",
    "scriptRun",
    "scriptCancel",
    "sshHosts",
    "sshProbe",
    "sshExec",
    "sshScriptRun",
    "sshScriptCancel",
    "homeDir",
    "platform",
    "pathExists",
    "removeDir",
    "copyTree",
    "copyPaths",
    "listFiles",
    "copyFileInto",
    "removeFileIn",
    "listDir",
    "readTextFile",
    "writeTextFile",
    "createDir",
    "renamePath",
    "removePath",
    "appVersion",
    "sharedGet",
    "sharedSet",
    "agentsSnapshot",
    "syncExport",
    "syncImport",
];
/// 붙은 기기에 전달하는 앱 이벤트
const FORWARDED_EVENTS: &[&str] = &[
    "pty-data",
    "pty-exit",
    "pty-resized",
    "script-log",
    "shared-changed",
    "agents-changed",
    "sync-applied",
];

pub fn allowed(method: &str, args: &Value) -> bool {
    if !ALLOWED.contains(&method) {
        return false;
    }
    // `gh auth token` 등은 토큰을 그대로 돌려준다
    if method == "ghRun" {
        let first = args.get(0).and_then(|a| a.get(0)).and_then(Value::as_str);
        return first != Some("auth");
    }
    true
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Device {
    pub id: String,
    pub name: String,
    /// 기기 토큰의 SHA-256 — 토큰 자체는 저장하지 않는다
    pub hash: String,
    pub created_ms: u64,
    pub last_seen_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    /// 사설 LAN 주소에도 연다(암호화되지 않는다)
    pub lan: bool,
    pub port: u16,
    pub devices: Vec<Device>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            lan: false,
            port: DEFAULT_PORT,
            devices: Vec::new(),
        }
    }
}

pub fn load_config(path: &Path) -> Config {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_config(path: &Path, c: &Config) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|e| format!("난수를 만들 수 없습니다: {e}"))?;
    Ok(buf)
}

pub fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

struct Pairing {
    code: String,
    expires: Instant,
    fails: u32,
}

/// 기기 등록 코드 확인 결과
#[derive(Debug, PartialEq)]
pub enum PairError {
    /// 등록을 시작하지 않았거나 만료·사용됨
    NotOpen,
    /// 코드가 틀림 — 남은 시도 횟수
    Wrong(u32),
}

#[derive(Default)]
pub struct Pairings(Mutex<Option<Pairing>>);

impl Pairings {
    pub fn start(&self) -> Result<String, String> {
        let n = u32::from_le_bytes(random_bytes::<4>()?) % 1_000_000;
        let code = format!("{n:06}");
        *self.0.lock().map_err(|e| e.to_string())? = Some(Pairing {
            code: code.clone(),
            expires: Instant::now() + PAIR_TTL,
            fails: 0,
        });
        Ok(code)
    }

    /// 개발 빌드의 격리 검증용: 정해 둔 코드로 등록을 열어 둔다(화면을 누르지 않고 등록 과정을 확인한다)
    fn preset(&self, code: String) {
        if let Ok(mut p) = self.0.lock() {
            *p = Some(Pairing {
                code,
                expires: Instant::now() + Duration::from_secs(3600),
                fails: 0,
            });
        }
    }

    pub fn cancel(&self) {
        if let Ok(mut p) = self.0.lock() {
            *p = None;
        }
    }

    /// 코드는 한 번만 쓸 수 있고, 여러 번 틀리면 무효가 된다(6자리 코드를 마구 넣어 맞히지 못하게)
    pub fn redeem(&self, code: &str) -> Result<(), PairError> {
        let mut slot = self.0.lock().map_err(|_| PairError::NotOpen)?;
        let Some(p) = slot.as_mut() else {
            return Err(PairError::NotOpen);
        };
        if Instant::now() > p.expires {
            *slot = None;
            return Err(PairError::NotOpen);
        }
        if p.code == code.trim() {
            *slot = None;
            return Ok(());
        }
        p.fails += 1;
        let left = PAIR_MAX_FAILS.saturating_sub(p.fails);
        if left == 0 {
            *slot = None;
        }
        Err(PairError::Wrong(left))
    }
}

/// 100.64.0.0/10 — Tailscale 이 쓰는 대역이지만 통신사 NAT(CGNAT)도 같은 대역을 쓴다
fn is_cgnat(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (o[1] & 0xc0) == 64
}

/// 열 주소를 고른다: 127.0.0.1 + Tailscale 주소 + (lan 이면) 사설 LAN. 공인 주소에는 열지 않는다.
/// Tailscale 주소는 tailscale 이 직접 알려 준 것만 쓴다 — 대역만 보고 고르면 통신사 NAT 주소(테더링 등)에도 열게 된다.
pub fn pick_addrs(
    all: &[Ipv4Addr],
    tailscale: &[Ipv4Addr],
    lan: bool,
) -> Vec<(Ipv4Addr, &'static str)> {
    let mut out = vec![(Ipv4Addr::LOCALHOST, "local")];
    for ip in all {
        if tailscale.contains(ip) {
            out.push((*ip, "tailscale"));
        } else if lan && ip.is_private() {
            out.push((*ip, "lan"));
        }
    }
    out.sort();
    out.dedup();
    out
}

/// `tailscale ip -4` 가 알려 주는 이 PC 의 Tailscale 주소(없거나 실행할 수 없으면 빈 목록). 잠깐 기억해 둔다
fn tailscale_addrs(all: &[Ipv4Addr]) -> Vec<Ipv4Addr> {
    static CACHE: Mutex<Option<(Instant, Vec<Ipv4Addr>)>> = Mutex::new(None);
    // 그 대역의 주소가 없으면 물어볼 것도 없다
    if !all.iter().any(is_cgnat) {
        return Vec::new();
    }
    if let Ok(c) = CACHE.lock() {
        if let Some((at, list)) = c.as_ref() {
            if at.elapsed() < Duration::from_secs(60) {
                return list.clone();
            }
        }
    }
    let mut candidates = vec![std::path::PathBuf::from("tailscale")];
    if cfg!(windows) {
        candidates.push(r"C:\Program Files\Tailscale\tailscale.exe".into());
    } else if cfg!(target_os = "macos") {
        candidates.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale".into());
    }
    let mut list = Vec::new();
    for exe in candidates {
        let mut cmd = std::process::Command::new(exe);
        cmd.args(["ip", "-4"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW — 콘솔 창이 깜박이지 않게
            cmd.creation_flags(0x0800_0000);
        }
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                list = String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .filter_map(|l| l.trim().parse().ok())
                    .collect();
                break;
            }
        }
    }
    if let Ok(mut c) = CACHE.lock() {
        *c = Some((Instant::now(), list.clone()));
    }
    list
}

fn listen_addrs(lan: bool) -> Vec<(Ipv4Addr, &'static str)> {
    let all = interface_addrs();
    pick_addrs(&all, &tailscale_addrs(&all), lan)
}

fn interface_addrs() -> Vec<Ipv4Addr> {
    if_addrs::get_if_addrs()
        .map(|list| {
            list.into_iter()
                .filter_map(|i| match i.ip() {
                    IpAddr::V4(v4) if !v4.is_loopback() => Some(v4),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Address {
    kind: &'static str,
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    id: String,
    name: String,
    created_ms: u64,
    last_seen_ms: u64,
    connected: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    enabled: bool,
    lan: bool,
    port: u16,
    addresses: Vec<Address>,
    devices: Vec<DeviceView>,
    /// 포트를 열지 못한 경우 등
    error: Option<String>,
}

struct Listeners {
    tasks: HashMap<SocketAddr, tauri::async_runtime::JoinHandle<()>>,
    error: Option<String>,
}

pub struct RemoteManager {
    path: PathBuf,
    shared_dir: PathBuf,
    config: Mutex<Config>,
    pairings: Pairings,
    listeners: Mutex<Listeners>,
    /// 붙은 기기에 보낼 이벤트(JSON 한 줄)
    events: broadcast::Sender<String>,
    shared_revs: Mutex<HashMap<String, u64>>,
    /// 열려 있는 WebSocket 수(기기 확인 전 포함)
    sockets: std::sync::atomic::AtomicUsize,
    /// 화면(웹뷰)에 맡긴 호출의 응답 대기
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    seq: AtomicU64,
    /// 기기 id → 붙어 있는 연결 수
    connected: Mutex<HashMap<String, u32>>,
    http: reqwest::Client,
    /// 이 PC 의 에이전트 현황(화면이 올려 둔 JSON 배열) — 이 PC 를 등록한 다른 PC 가 통합 현황·알림에 쓴다
    agents: Mutex<String>,
    peers_path: PathBuf,
}

impl RemoteManager {
    pub fn new(config_dir: &Path) -> Self {
        let path = config_dir.join("remote.json");
        Self {
            config: Mutex::new(load_config(&path)),
            path,
            shared_dir: config_dir.join("shared"),
            pairings: Pairings::default(),
            listeners: Mutex::new(Listeners {
                tasks: HashMap::new(),
                error: None,
            }),
            events: broadcast::channel(1024).0,
            shared_revs: Mutex::new(HashMap::new()),
            sockets: std::sync::atomic::AtomicUsize::new(0),
            pending: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
            connected: Mutex::new(HashMap::new()),
            http: reqwest::Client::new(),
            agents: Mutex::new("[]".to_string()),
            peers_path: config_dir.join("peers.json"),
        }
    }

    fn config(&self) -> Config {
        self.config.lock().map(|c| c.clone()).unwrap_or_default()
    }

    fn update<F: FnOnce(&mut Config)>(&self, f: F) -> Result<(), String> {
        let mut c = self.config.lock().map_err(|e| e.to_string())?;
        f(&mut c);
        save_config(&self.path, &c)
    }

    /// 토큰으로 기기를 찾는다(없으면 등록되지 않았거나 끊은 기기)
    fn device_of(&self, token: &str) -> Option<String> {
        let hash = hash_token(token);
        let c = self.config.lock().ok()?;
        if !c.enabled {
            return None;
        }
        c.devices
            .iter()
            .find(|d| d.hash == hash)
            .map(|d| d.id.clone())
    }

    fn device_exists(&self, id: &str) -> bool {
        self.config
            .lock()
            .map(|c| c.enabled && c.devices.iter().any(|d| d.id == id))
            .unwrap_or(false)
    }

    fn touch(&self, id: &str) {
        let _ = self.update(|c| {
            if let Some(d) = c.devices.iter_mut().find(|d| d.id == id) {
                d.last_seen_ms = now_ms();
            }
        });
    }

    pub fn status(&self) -> Status {
        let c = self.config();
        let connected = self.connected.lock().map(|m| m.clone()).unwrap_or_default();
        let addresses = if c.enabled {
            listen_addrs(c.lan)
                .into_iter()
                .map(|(ip, kind)| Address {
                    kind,
                    url: format!("http://{ip}:{}", c.port),
                })
                .collect()
        } else {
            Vec::new()
        };
        Status {
            enabled: c.enabled,
            lan: c.lan,
            port: c.port,
            addresses,
            devices: c
                .devices
                .iter()
                .map(|d| DeviceView {
                    id: d.id.clone(),
                    name: d.name.clone(),
                    created_ms: d.created_ms,
                    last_seen_ms: d.last_seen_ms,
                    connected: connected.get(&d.id).copied().unwrap_or(0) > 0,
                })
                .collect(),
            error: self.listeners.lock().ok().and_then(|l| l.error.clone()),
        }
    }

    /// 설정에 맞게 리스너를 맞춘다(꺼졌으면 모두 닫고, 주소가 바뀌었으면 새로 연다). 주기적으로도 부른다 —
    /// Tailscale 을 나중에 켜거나 네트워크가 바뀌면 주소가 달라진다.
    pub fn reconcile(&self, app: &AppHandle) {
        let c = self.config();
        let want: Vec<SocketAddr> = if c.enabled {
            listen_addrs(c.lan)
                .into_iter()
                .map(|(ip, _)| SocketAddr::new(IpAddr::V4(ip), c.port))
                .collect()
        } else {
            Vec::new()
        };
        let Ok(mut l) = self.listeners.lock() else {
            return;
        };
        l.tasks.retain(|addr, task| {
            let keep = want.contains(addr);
            if !keep {
                task.abort();
            }
            keep
        });
        l.error = None;
        for addr in want {
            if l.tasks.contains_key(&addr) {
                continue;
            }
            // 동기 bind 로 실패(포트 사용 중 등)를 바로 안다
            match std::net::TcpListener::bind(addr).and_then(|s| {
                s.set_nonblocking(true)?;
                Ok(s)
            }) {
                Ok(std_listener) => {
                    let app = app.clone();
                    let task = tauri::async_runtime::spawn(async move {
                        let Ok(listener) = tokio::net::TcpListener::from_std(std_listener) else {
                            return;
                        };
                        let _ = axum::serve(listener, router(app)).await;
                    });
                    l.tasks.insert(addr, task);
                }
                Err(e) => l.error = Some(format!("{addr} 를 열 수 없습니다: {e}")),
            }
        }
    }

    /// 화면(웹뷰)에 호출을 맡기고 응답을 기다린다 — 기존 명령을 그대로 재사용한다
    async fn call_webview(
        &self,
        app: &AppHandle,
        method: &str,
        args: Value,
    ) -> Result<Value, String> {
        let id = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, tx);
        if let Err(e) = app.emit(
            "remote-rpc",
            json!({ "id": id, "method": method, "args": args }),
        ) {
            self.pending.lock().map_err(|e| e.to_string())?.remove(&id);
            return Err(e.to_string());
        }
        match tokio::time::timeout(RPC_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("호스트 화면이 응답하지 않았습니다".into()),
            Err(_) => {
                if let Ok(mut p) = self.pending.lock() {
                    p.remove(&id);
                }
                Err("호스트의 응답 시간이 초과되었습니다".into())
            }
        }
    }

    fn shared_path(&self, key: &str) -> Result<PathBuf, String> {
        if key.is_empty()
            || !key
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(format!("공유 상태 이름이 올바르지 않습니다: {key}"));
        }
        Ok(self.shared_dir.join(format!("{key}.json")))
    }

    /// 값과 판 번호(rev). 판 번호는 앱이 떠 있는 동안 저장할 때마다 1씩 오른다
    pub fn shared_get(&self, key: &str) -> Result<SharedValue, String> {
        let path = self.shared_path(key)?;
        let revs = self.shared_revs.lock().map_err(|e| e.to_string())?;
        let value = match std::fs::read_to_string(path) {
            Ok(t) => Some(t),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        Ok(SharedValue {
            value,
            rev: revs.get(key).copied().unwrap_or(0),
        })
    }

    /// base 는 이 화면이 마지막으로 본 판 번호다. 그 사이 다른 화면이 저장했으면(판 번호가 다르면) 거절한다 —
    /// 그대로 덮어쓰면 다른 화면의 변경(방금 나눈 터미널 패널 등)이 사라진다. 거절당한 화면은 다시 읽어 합친 뒤 저장한다.
    pub fn shared_set(
        &self,
        app: &AppHandle,
        key: &str,
        value: &str,
        origin: &str,
        base: u64,
    ) -> Result<u64, String> {
        let rev = self.shared_store(key, value, base)?;
        // 다른 화면(이 PC 의 창·붙은 기기)이 다시 읽게 알린다. origin 은 바꾼 화면 — 자기 것은 다시 읽지 않는다
        let _ = app.emit(
            "shared-changed",
            json!({ "key": key, "origin": origin, "rev": rev }),
        );
        Ok(rev)
    }

    fn shared_store(&self, key: &str, value: &str, base: u64) -> Result<u64, String> {
        let path = self.shared_path(key)?;
        let mut revs = self.shared_revs.lock().map_err(|e| e.to_string())?;
        let current = revs.get(key).copied().unwrap_or(0);
        if base != current {
            return Err(SHARED_CONFLICT.to_string());
        }
        std::fs::create_dir_all(&self.shared_dir).map_err(|e| e.to_string())?;
        // 임시 파일에 쓰고 바꿔치기 — 쓰는 도중 꺼져도 반쯤 쓴 파일이 남지 않는다
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, value).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        revs.insert(key.to_string(), current + 1);
        Ok(current + 1)
    }

    /// 화면(웹뷰)이 새로 고쳐지면 맡겨 둔 호출의 답은 오지 않는다 — 기다리게 두지 않고 바로 실패시킨다
    pub fn fail_pending(&self) {
        if let Ok(mut p) = self.pending.lock() {
            p.clear();
        }
    }
}

/// 공유 상태 저장이 겹쳤다(desktop/src/lib/sharedState.ts 와 같아야 한다)
pub const SHARED_CONFLICT: &str = "shared_conflict";

#[derive(Serialize)]
pub struct SharedValue {
    value: Option<String>,
    rev: u64,
}

/// 앱 시작 시: 설정을 읽고, 이벤트 전달과 주기적인 주소 확인을 건다
pub fn init(app: &AppHandle) {
    let Ok(dirs) = profile::dirs(app) else {
        return;
    };
    app.manage(RemoteManager::new(&dirs.config));
    if cfg!(debug_assertions) {
        if let Ok(code) = std::env::var("MINMO_REMOTE_TEST_PAIR_CODE") {
            app.state::<RemoteManager>().pairings.preset(code);
        }
        // 격리 검증용: 시작하면서 다른 PC 의 창을 연다("<PC id>" 또는 "<PC id>|<열 곳 JSON>")
        if let Ok(spec) = std::env::var("MINMO_REMOTE_TEST_OPEN_PEER") {
            let (id, open) = match spec.split_once('|') {
                Some((id, json)) => (id.to_string(), serde_json::from_str(json).ok()),
                None => (spec.clone(), None),
            };
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(4)).await;
                let _ = peer_open(handle, id, open).await;
            });
        }
    }
    for name in FORWARDED_EVENTS {
        let handle = app.clone();
        app.listen_any(*name, move |e| {
            let mgr = handle.state::<RemoteManager>();
            // 붙은 기기가 없으면 보내지 않는다(터미널 출력은 양이 많다)
            if mgr.events.receiver_count() > 0 {
                let _ = mgr
                    .events
                    .send(format!(r#"{{"event":"{name}","payload":{}}}"#, e.payload()));
            }
        });
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            handle.state::<RemoteManager>().reconcile(&handle);
            tokio::time::sleep(Duration::from_secs(20)).await;
        }
    });
}

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
}

impl Ctx {
    fn mgr(&self) -> tauri::State<'_, RemoteManager> {
        self.app.state::<RemoteManager>()
    }
}

fn router(app: AppHandle) -> Router {
    Router::new()
        .route("/pair", post(pair))
        .route("/ws", get(ws_upgrade))
        .route("/api/{*path}", any(proxy_api))
        .route("/gh/{*path}", any(proxy_github))
        .fallback(get(asset))
        .layer(axum::middleware::from_fn(check_host))
        .with_state(Ctx { app })
}

fn text(status: StatusCode, body: &str) -> Response {
    (status, body.to_string()).into_response()
}

#[derive(Deserialize)]
struct PairBody {
    code: String,
    #[serde(default)]
    name: String,
}

async fn pair(AxState(ctx): AxState<Ctx>, Json(body): Json<PairBody>) -> Response {
    let mgr = ctx.mgr();
    if !mgr.config().enabled {
        return text(StatusCode::NOT_FOUND, "not_enabled");
    }
    match mgr.pairings.redeem(&body.code) {
        Ok(()) => {}
        Err(PairError::NotOpen) => return text(StatusCode::FORBIDDEN, "pair_not_open"),
        Err(PairError::Wrong(left)) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "pair_wrong_code", "left": left })),
            )
                .into_response()
        }
    }
    let (Ok(raw), Ok(id)) = (random_bytes::<32>(), random_bytes::<8>()) else {
        return text(StatusCode::INTERNAL_SERVER_ERROR, "random_failed");
    };
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    let id: String = id.iter().map(|b| format!("{b:02x}")).collect();
    let name: String = body
        .name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect();
    let device = Device {
        id: id.clone(),
        name: if name.is_empty() {
            "이름 없는 기기".into()
        } else {
            name
        },
        hash: hash_token(&token),
        created_ms: now_ms(),
        last_seen_ms: now_ms(),
    };
    if let Err(e) = mgr.update(|c| c.devices.push(device)) {
        return text(StatusCode::INTERNAL_SERVER_ERROR, &e);
    }
    // 이 PC 의 화면이 기기 목록을 다시 그리게
    let _ = ctx.app.emit("remote-changed", ());
    Json(json!({ "token": token, "deviceId": id })).into_response()
}

fn device_from_headers(ctx: &Ctx, headers: &HeaderMap) -> Option<String> {
    let token = headers.get(DEVICE_HEADER)?.to_str().ok()?;
    ctx.mgr().device_of(token)
}

/// 동시에 열어 둘 수 있는 WebSocket 수 — 기기 확인 전의 연결로 자원을 잡아 두지 못하게 한다
const MAX_SOCKETS: usize = 64;

struct SocketSlot(Ctx);

impl Drop for SocketSlot {
    fn drop(&mut self) {
        self.0.mgr().sockets.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn ws_upgrade(AxState(ctx): AxState<Ctx>, ws: WebSocketUpgrade) -> Response {
    if ctx.mgr().sockets.fetch_add(1, Ordering::SeqCst) >= MAX_SOCKETS {
        ctx.mgr().sockets.fetch_sub(1, Ordering::SeqCst);
        return text(StatusCode::SERVICE_UNAVAILABLE, "too_many_connections");
    }
    let slot = SocketSlot(ctx.clone());
    ws.max_message_size(MAX_BODY)
        .on_upgrade(move |socket| async move {
            let _slot = slot;
            ws_session(ctx, socket).await
        })
}

/// 주소창의 호스트 이름이 믿을 수 있는 모양인가: IP 주소, 점 없는 이름(localhost·tailnet 의 기기 이름), *.ts.net.
/// 다른 도메인이 이 PC 의 주소를 가리키게 해(DNS rebinding) 그 사이트의 스크립트가 이 서버와 같은 출처가 되는 것을 막는다.
pub fn host_allowed(host: &str) -> bool {
    let name = match host.strip_prefix('[') {
        // [IPv6]:port
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => host.rsplit_once(':').map_or(host, |(h, port)| {
            if port.chars().all(|c| c.is_ascii_digit()) {
                h
            } else {
                host
            }
        }),
    };
    !name.is_empty()
        && (name.parse::<IpAddr>().is_ok()
            || !name.contains('.')
            || name.to_ascii_lowercase().ends_with(".ts.net"))
}

async fn check_host(req: Request, next: axum::middleware::Next) -> Response {
    let ok = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(host_allowed);
    if ok {
        next.run(req).await
    } else {
        text(StatusCode::MISDIRECTED_REQUEST, "host_not_allowed")
    }
}

/// 연결이 끊기면(어떤 경로로든) 붙은 기기 수를 줄인다
struct Connected {
    ctx: Ctx,
    id: String,
}

impl Drop for Connected {
    fn drop(&mut self) {
        if let Ok(mut m) = self.ctx.mgr().connected.lock() {
            if let Some(n) = m.get_mut(&self.id) {
                *n = n.saturating_sub(1);
            }
        }
        let _ = self.ctx.app.emit("remote-changed", ());
    }
}

async fn ws_session(ctx: Ctx, mut socket: WebSocket) {
    // 첫 메시지는 기기 토큰이어야 한다(브라우저 WebSocket 은 헤더를 붙일 수 없다)
    let first = tokio::time::timeout(Duration::from_secs(10), socket.recv()).await;
    let token = match first {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<Value>(t.as_str())
            .ok()
            .and_then(|v| v.get("auth").and_then(Value::as_str).map(str::to_string)),
        // 시간 안에 토큰이 오지 않았다(느린 연결) — "거절"로 답하지 않고 닫는다. 거절로 답하면 화면이 등록을 지운다
        Err(_) | Ok(None) | Ok(Some(Err(_))) => return,
        _ => None,
    };
    let Some(device) = token.and_then(|t| ctx.mgr().device_of(&t)) else {
        let _ = socket.send(Message::Text(r#"{"auth":false}"#.into())).await;
        return;
    };
    if socket
        .send(Message::Text(r#"{"auth":true}"#.into()))
        .await
        .is_err()
    {
        return;
    }
    if let Ok(mut m) = ctx.mgr().connected.lock() {
        *m.entry(device.clone()).or_insert(0) += 1;
    }
    let _guard = Connected {
        ctx: ctx.clone(),
        id: device.clone(),
    };
    ctx.mgr().touch(&device);
    let _ = ctx.app.emit("remote-changed", ());

    let mut events = ctx.mgr().events.subscribe();
    // 호출은 오래 걸릴 수 있으므로(git fetch 등) 따로 돌리고 결과만 이 채널로 모은다 — 그동안 터미널 입력이 막히지 않게
    let (reply_tx, mut reply_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut check = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            msg = socket.recv() => {
                let Some(Ok(msg)) = msg else { break };
                let Message::Text(t) = msg else { continue };
                let Ok(req) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                let (Some(id), Some(method)) = (req.get("id").and_then(Value::as_u64), req.get("method").and_then(Value::as_str)) else { continue };
                let args = req.get("args").cloned().unwrap_or(Value::Array(Vec::new()));
                let (ctx, method, tx) = (ctx.clone(), method.to_string(), reply_tx.clone());
                tauri::async_runtime::spawn(async move {
                    let out = match call(&ctx, &method, args).await {
                        Ok(v) => json!({ "id": id, "ok": true, "value": v }),
                        Err(e) => json!({ "id": id, "ok": false, "error": e }),
                    };
                    let _ = tx.send(out.to_string());
                });
            }
            Some(out) = reply_rx.recv() => {
                if socket.send(Message::Text(out.into())).await.is_err() { break }
            }
            ev = events.recv() => match ev {
                Ok(line) => if socket.send(Message::Text(line.into())).await.is_err() { break },
                // 너무 밀려 일부를 놓쳤다 — 화면이 터미널을 다시 붙여(지난 출력으로) 맞추게 알린다
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if socket.send(Message::Text(r#"{"event":"lagged","payload":null}"#.into())).await.is_err() { break }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = check.tick() => {
                // 이 PC 에서 기기를 끊었거나 원격 접속을 껐으면 바로 닫는다
                if !ctx.mgr().device_exists(&device) { break }
            }
        }
    }
}

fn arg<T: serde::de::DeserializeOwned>(args: &Value, i: usize) -> Result<T, String> {
    serde_json::from_value(args.get(i).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("인자 {i}: {e}"))
}

/// 호출 하나를 실행한다. 터미널과 공유 상태는 여기서 바로 처리하고(화면이 바쁘거나 숨겨져 있어도 입력이 밀리지 않게),
/// 나머지는 이 PC 의 화면에 맡겨 기존 명령을 그대로 쓴다.
async fn call(ctx: &Ctx, method: &str, args: Value) -> Result<Value, String> {
    if !allowed(method, &args) {
        return Err(format!("원격에서 쓸 수 없는 기능입니다: {method}"));
    }
    let app = &ctx.app;
    let ptys = || app.state::<pty::PtyState>();
    let ok = |v: Result<(), String>| v.map(|()| Value::Null);
    let to = |v: Result<Value, serde_json::Error>| v.map_err(|e| e.to_string());
    match method {
        "ptyWrite" => ok(pty::pty_write(ptys(), arg(&args, 0)?, arg(&args, 1)?)),
        "ptyResize" => ok(pty::pty_resize(
            app.clone(),
            ptys(),
            arg(&args, 0)?,
            arg(&args, 1)?,
            arg(&args, 2)?,
        )),
        "ptySpawn" => {
            #[derive(Deserialize)]
            struct Spawn {
                cwd: String,
                cols: u16,
                rows: u16,
                #[serde(default)]
                remote: Option<pty::RemotePty>,
                #[serde(default)]
                key: Option<String>,
            }
            let o: Spawn = arg(&args, 0)?;
            pty::pty_spawn(app.clone(), ptys(), o.cwd, o.cols, o.rows, o.remote, o.key)
                .map(Value::String)
        }
        "ptyFind" => to(serde_json::to_value(pty::pty_find(ptys(), arg(&args, 0)?)?)),
        "ptyList" => to(serde_json::to_value(pty::pty_list(ptys())?)),
        "sharedGet" => to(serde_json::to_value(
            ctx.mgr().shared_get(&arg::<String>(&args, 0)?)?,
        )),
        "sharedSet" => ctx
            .mgr()
            .shared_set(
                app,
                &arg::<String>(&args, 0)?,
                &arg::<String>(&args, 1)?,
                &arg::<String>(&args, 2)?,
                arg(&args, 3)?,
            )
            .map(Value::from),
        "appVersion" => Ok(Value::String(app.package_info().version.to_string())),
        // PC 사이 동기화: 이 PC 서버의 설정·메모를 통째로 내주고, 받은 것 중 더 새로운 것만 넣는다(서버가 가린다)
        "syncExport" => sync_server(ctx, Method::GET, None).await,
        "syncImport" => {
            let out = sync_server(ctx, Method::PUT, Some(arg::<Value>(&args, 0)?)).await?;
            // 이 PC 의 화면들(본창·붙은 기기)이 설정·메모를 다시 읽게 한다
            let _ = app.emit("sync-applied", ());
            Ok(out)
        }
        "agentsSnapshot" => {
            let raw = ctx.mgr().agents.lock().map_err(|e| e.to_string())?.clone();
            serde_json::from_str(&raw).map_err(|e| e.to_string())
        }
        _ => {
            // 원격 화면은 GitHub 토큰 대신 표식을 보낸다 — 명령을 실행하는 호출에서만 실제 토큰으로 바꾼다
            // (파일 쓰기 같은 호출에서는 바꾸지 않는다 — 써 놓고 읽으면 토큰이 그대로 나온다)
            let args = if TOKEN_METHODS.contains(&method) {
                substitute_token(ctx, args).await
            } else {
                args
            };
            ctx.mgr().call_webview(app, method, args).await
        }
    }
}

/// GitHub 토큰 표식을 실제 토큰으로 바꿔 주는 호출 — git·ssh 로 원격 저장소에 접근하는 것들
const TOKEN_METHODS: &[&str] = &["gitRun", "ghRun", "sshExec", "sshScriptRun", "scriptRun"];

async fn substitute_token(ctx: &Ctx, args: Value) -> Value {
    let raw = args.to_string();
    if !raw.contains(TOKEN_SENTINEL) {
        return args;
    }
    let Some(token) = github_token(ctx).await else {
        return args;
    };
    // 토큰은 JSON 문자열 안에 들어가므로 따옴표·역슬래시가 없어야 한다(GitHub 토큰은 영숫자와 _ 뿐)
    if !token
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return args;
    }
    serde_json::from_str(&raw.replace(TOKEN_SENTINEL, &token)).unwrap_or(args)
}

/// 이 PC 의 minmo 서버의 동기화 경로(/me/sync)를 이 PC 의 세션으로 부른다
async fn sync_server(ctx: &Ctx, method: Method, body: Option<Value>) -> Result<Value, String> {
    let session = session_token().ok_or("호스트 PC 의 minmo 에서 먼저 로그인하세요")?;
    let mut req = ctx
        .mgr()
        .http
        .request(method, format!("{}/me/sync", api_base(ctx)))
        .bearer_auth(session);
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    if !status.is_success() {
        // 옛 버전의 서버에는 이 경로가 없다
        return Err(format!(
            "그 PC 의 서버가 동기화를 처리하지 못했습니다({status})"
        ));
    }
    res.json().await.map_err(|e| e.to_string())
}

fn api_base(ctx: &Ctx) -> String {
    format!(
        "http://127.0.0.1:{}",
        ctx.app.state::<server::ServerManager>().status().port
    )
}

fn session_token() -> Option<String> {
    keychain::get("minmo.session").ok().flatten()
}

async fn github_token(ctx: &Ctx) -> Option<String> {
    if let Ok(Some(t)) = keychain::get("minmo.github-token") {
        return Some(t);
    }
    // 키체인에 없으면 이 PC 의 서버에 묻는다
    let session = session_token()?;
    let res = ctx
        .mgr()
        .http
        .get(format!("{}/me/github-token", api_base(ctx)))
        .bearer_auth(session)
        .send()
        .await
        .ok()?;
    let v: Value = res.json().await.ok()?;
    v.get("accessToken")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// GitHub API 주소. 개발 빌드에서는 서버와 같은 환경 변수로 바꿀 수 있다(격리 E2E 의 가짜 GitHub)
fn github_api_base() -> String {
    if cfg!(debug_assertions) {
        if let Ok(v) = std::env::var("MINMO_GITHUB_API_BASE") {
            return v.trim_end_matches('/').to_string();
        }
    }
    "https://api.github.com".to_string()
}

/// 원격 화면이 부를 수 있는 서버 요청인가. 화면이 쓰는 것만 허용한다(설정·메모·보일 저장소·내 정보).
/// 로그인·세션·토큰·CLI 코드(/auth/*, /me/github-token, /me/sessions, /me/cli-codes)는 이 PC 에서만 한다.
/// 경로는 글자 그대로 본다 — 인코딩(%)이나 `.`·`..`·빈 구간이 있으면 거절한다(서버가 다르게 풀이해 막은 경로에 닿지 않게).
pub fn api_request_allowed(method: &Method, path: &str) -> bool {
    if !(method == Method::GET || method == Method::PUT) {
        return false;
    }
    let Some(rest) = path.strip_prefix('/') else {
        return false;
    };
    let segs: Vec<&str> = rest.split('/').collect();
    let plain = |s: &&str| {
        !s.is_empty()
            && *s != "."
            && *s != ".."
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    };
    if !segs.iter().all(plain) {
        return false;
    }
    match segs.as_slice() {
        ["me"] => method == Method::GET,
        ["me", "visible-repos"] | ["settings"] => true,
        ["orgs", _, "settings"] | ["projects", _, _, "settings"] => true,
        ["projects", _, _, "settings", "effective"] => method == Method::GET,
        ["projects", _, _, "issues", _, "notes"] => true,
        _ => false,
    }
}

async fn forward(ctx: &Ctx, req: Request, url: String, bearer: String, github: bool) -> Response {
    let method = req.method().clone();
    let content_type = req.headers().get(header::CONTENT_TYPE).cloned();
    let accept = req.headers().get(header::ACCEPT).cloned();
    let Ok(body) = axum::body::to_bytes(req.into_body(), MAX_BODY).await else {
        return text(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large");
    };
    let mut out = ctx
        .mgr()
        .http
        .request(method, url)
        .bearer_auth(bearer)
        .body(body);
    if let Some(v) = content_type {
        out = out.header(header::CONTENT_TYPE, v);
    }
    if let Some(v) = accept {
        out = out.header(header::ACCEPT, v);
    }
    if github {
        out = out
            .header(header::USER_AGENT, "minmo")
            .header("X-GitHub-Api-Version", "2022-11-28");
    }
    match out.send().await {
        Ok(res) => {
            let status =
                StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let headers = res.headers().clone();
            let bytes = res.bytes().await.unwrap_or_default();
            let mut resp = Response::new(Body::from(bytes));
            *resp.status_mut() = status;
            // 화면이 쓰는 것만 넘긴다(페이지 넘김 link, 요청 한도 등)
            for name in [
                "content-type",
                "link",
                "etag",
                "x-ratelimit-remaining",
                "x-ratelimit-reset",
                "retry-after",
            ] {
                if let Some(v) = headers
                    .get(name)
                    .and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok())
                {
                    resp.headers_mut()
                        .insert(header::HeaderName::from_static(name), v);
                }
            }
            resp
        }
        Err(e) => text(StatusCode::BAD_GATEWAY, &e.to_string()),
    }
}

fn path_and_query(req: &Request, prefix: &str) -> String {
    let pq = req
        .uri()
        .path_and_query()
        .map_or(req.uri().path(), |p| p.as_str());
    pq.strip_prefix(prefix).unwrap_or(pq).to_string()
}

async fn proxy_api(AxState(ctx): AxState<Ctx>, req: Request) -> Response {
    if device_from_headers(&ctx, req.headers()).is_none() {
        return text(StatusCode::UNAUTHORIZED, "device_required");
    }
    let rest = path_and_query(&req, "/api");
    if !api_request_allowed(req.method(), rest.split('?').next().unwrap_or("")) {
        return text(StatusCode::FORBIDDEN, "remote_forbidden");
    }
    let Some(session) = session_token() else {
        // 이 PC 에서 로그인하지 않았다
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": { "code": "host_not_logged_in", "message": "호스트 PC 의 minmo 에서 먼저 로그인하세요" } }))).into_response();
    };
    let url = format!("{}{rest}", api_base(&ctx));
    forward(&ctx, req, url, session, false).await
}

async fn proxy_github(AxState(ctx): AxState<Ctx>, req: Request) -> Response {
    if device_from_headers(&ctx, req.headers()).is_none() {
        return text(StatusCode::UNAUTHORIZED, "device_required");
    }
    if req.method() == Method::OPTIONS {
        return StatusCode::NO_CONTENT.into_response();
    }
    let Some(token) = github_token(&ctx).await else {
        return text(StatusCode::UNAUTHORIZED, "host_not_logged_in");
    };
    let url = format!("{}{}", github_api_base(), path_and_query(&req, "/gh"));
    forward(&ctx, req, url, token, true).await
}

/// desktop/src/lib/tauri.ts 의 runtimeKind 가 읽는 표시
const REMOTE_MARK: &str = r#"<meta name="minmo-runtime" content="remote" />"#;

/// index.html 의 <head> 바로 뒤에 표시를 넣는다(<head> 가 없으면 그대로 둔다)
fn mark_remote(html: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(html);
    // <head> 에 속성이 붙어 있어도 찾는다
    match text
        .find("<head")
        .and_then(|i| text[i..].find('>').map(|j| i + j + 1))
    {
        Some(at) => format!("{}{REMOTE_MARK}{}", &text[..at], &text[at..]).into_bytes(),
        None => html.to_vec(),
    }
}

/// 웹 화면 파일 — 앱에 들어 있는 것과 같은 것을 내준다. 없는 경로는 index.html(화면이 주소를 직접 다룬다)
async fn asset(AxState(ctx): AxState<Ctx>, req: Request) -> Response {
    let path = req.uri().path().trim_start_matches('/').to_string();
    let resolver = ctx.app.asset_resolver();
    let (found, is_index) = match resolver.get(path.clone()) {
        Some(a) if !path.is_empty() => (Some(a), path == "index.html"),
        _ => (resolver.get("index.html".into()), true),
    };
    let Some(a) = found else {
        return text(
            StatusCode::NOT_FOUND,
            "웹 화면 파일이 없습니다(개발 모드에서는 빌드한 앱으로 확인하세요)",
        );
    };
    // 앱의 파일 찾기는 없는 경로에도 index.html 을 돌려준다 — 받은 내용이 index.html 과 같으면 요청한 이름과 상관없이
    // 화면 파일로 다룬다(형식 추측만으로는 가릴 수 없다: .webmanifest 도 text/html 로 추측된다)
    let is_index = is_index
        || (a.mime_type.starts_with("text/html")
            && resolver
                .get("index.html".into())
                .is_some_and(|i| i.bytes == a.bytes));
    // 화면 파일에는 "호스트가 내준 화면"이라는 표시를 넣는다. 다른 PC 의 minmo 앱이 이 화면을 자기 창으로 열면
    // 그 창에도 앱의 네이티브 다리(__TAURI_INTERNALS__)가 있어, 표시가 없으면 화면이 자신을 그 앱의 본창으로 착각한다
    // (네이티브 호출은 권한이 없어 거절되고 화면은 뜨지 못한다 — 실제 창에서 확인)
    let bytes = if is_index {
        mark_remote(&a.bytes)
    } else {
        a.bytes.to_vec()
    };
    let mut resp = Response::new(Body::from(bytes));
    // 앱에 들어 있는 파일의 형식 추측은 .webmanifest 를 모른다 — 홈 화면에 추가할 때 브라우저가 읽는 파일이다
    let mime = if !is_index && path.ends_with(".webmanifest") {
        "application/manifest+json"
    } else {
        a.mime_type.as_str()
    };
    if let Ok(v) = HeaderValue::from_str(mime) {
        resp.headers_mut().insert(header::CONTENT_TYPE, v);
    }
    let h = resp.headers_mut();
    // 빌드가 만든 파일(assets/)은 이름에 해시가 붙어 내용이 바뀌면 이름도 바뀐다 — 오래 기억해도 된다.
    // 그 밖의 파일(index.html, manifest, 아이콘)은 이름이 그대로이므로 매번 새로 확인한다
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if !is_index && path.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    if is_index {
        // 같은 출처(이 서버)와만 통신한다. 다른 사이트의 틀 안에 넣지 못하게 한다
        h.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: https://avatars.githubusercontent.com; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'self'"),
        );
    }
    resp
}

// ── 이 PC 의 화면이 부르는 명령 ─────────────────────────────────────────────

#[tauri::command]
pub fn remote_status(app: AppHandle) -> Status {
    app.state::<RemoteManager>().status()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigInput {
    enabled: Option<bool>,
    lan: Option<bool>,
    port: Option<u16>,
}

#[tauri::command]
pub fn remote_configure(app: AppHandle, input: ConfigInput) -> Result<Status, String> {
    let mgr = app.state::<RemoteManager>();
    if let Some(p) = input.port {
        server::validate_port(p)?;
        if p == app.state::<server::ServerManager>().settings().port {
            return Err("내장 서버와 같은 포트는 쓸 수 없습니다".into());
        }
    }
    mgr.update(|c| {
        if let Some(v) = input.enabled {
            c.enabled = v;
        }
        if let Some(v) = input.lan {
            c.lan = v;
        }
        if let Some(v) = input.port {
            c.port = v;
        }
    })?;
    if !mgr.config().enabled {
        mgr.pairings.cancel();
    }
    // 포트가 바뀌면 옛 리스너를 모두 닫고 다시 연다
    if input.port.is_some() {
        if let Ok(mut l) = mgr.listeners.lock() {
            for (_, t) in l.tasks.drain() {
                t.abort();
            }
        }
    }
    mgr.reconcile(&app);
    Ok(mgr.status())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStart {
    code: String,
    expires_in_sec: u64,
}

#[tauri::command]
pub fn remote_pair_start(app: AppHandle) -> Result<PairStart, String> {
    let mgr = app.state::<RemoteManager>();
    if !mgr.config().enabled {
        return Err("원격 접속이 꺼져 있습니다".into());
    }
    Ok(PairStart {
        code: mgr.pairings.start()?,
        expires_in_sec: PAIR_TTL.as_secs(),
    })
}

#[tauri::command]
pub fn remote_pair_cancel(app: AppHandle) {
    app.state::<RemoteManager>().pairings.cancel();
}

/// 기기를 끊는다 — 그 기기의 토큰은 더 이상 통하지 않고, 붙어 있는 연결도 곧 닫힌다
#[tauri::command]
pub fn remote_device_remove(app: AppHandle, id: String) -> Result<Status, String> {
    let mgr = app.state::<RemoteManager>();
    mgr.update(|c| c.devices.retain(|d| d.id != id))?;
    Ok(mgr.status())
}

/// 이 PC 의 화면이 에이전트 현황(줄 목록)을 올린다 — 바뀌었을 때만 붙은 기기에 알린다
#[tauri::command]
pub fn agents_publish(app: AppHandle, rows: Value) -> Result<(), String> {
    if !rows.is_array() {
        return Err("에이전트 현황은 목록이어야 합니다".into());
    }
    let raw = rows.to_string();
    {
        let mgr = app.state::<RemoteManager>();
        let mut cur = mgr.agents.lock().map_err(|e| e.to_string())?;
        if *cur == raw {
            return Ok(());
        }
        *cur = raw;
    }
    let _ = app.emit("agents-changed", rows);
    Ok(())
}

// ── 다른 PC(이 PC 가 접속하는 호스트) ────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerView {
    id: String,
    name: String,
    url: String,
    /// 그 PC 가 이 PC 에 발급한 기기 토큰(키체인에 둔다) — 이 PC 의 화면이 그 PC 에 붙을 때 쓴다
    token: Option<String>,
}

fn peer_key(id: &str) -> String {
    format!("minmo.peer.{id}")
}

fn load_peers(path: &Path) -> Vec<Peer> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_peers(path: &Path, peers: &[Peer]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(peers).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

fn peer_views(path: &Path) -> Vec<PeerView> {
    load_peers(path)
        .into_iter()
        .map(|p| PeerView {
            token: keychain::get(&peer_key(&p.id)).ok().flatten(),
            id: p.id,
            name: p.name,
            url: p.url,
        })
        .collect()
}

/// 사용자가 적은 주소를 `http(s)://호스트[:포트]` 로 맞춘다. 적지 않으면 http 와 기본 포트로 본다
pub fn normalize_peer_url(input: &str) -> Result<String, String> {
    let t = input.trim();
    let (scheme, rest) = match t.split_once("://") {
        Some((s, r)) if s.eq_ignore_ascii_case("http") || s.eq_ignore_ascii_case("https") => {
            (s.to_ascii_lowercase(), r)
        }
        Some(_) => return Err("주소는 http:// 또는 https:// 로 시작해야 합니다".into()),
        None => ("http".to_string(), t),
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let ok = !host.is_empty()
        && !host.ends_with(':')
        && !host.contains('@')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'));
    if !ok {
        return Err(format!("주소가 올바르지 않습니다: {input}"));
    }
    // 포트를 적지 않은 http 주소는 원격 접속의 기본 포트로 본다(https 는 tailscale serve 등 443)
    let has_port = host
        .rsplit_once(':')
        .is_some_and(|(_, p)| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if scheme == "http" && !has_port {
        Ok(format!("http://{host}:{DEFAULT_PORT}"))
    } else {
        Ok(format!("{scheme}://{host}"))
    }
}

fn this_device_name() -> String {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default();
    if host.trim().is_empty() {
        "minmo 데스크톱".to_string()
    } else {
        format!("{} (minmo)", host.trim())
    }
}

/// 이 PC 의 이름 — 다른 PC 에 기기로 등록될 때의 이름이자, 동기화의 충돌 사본에 적는 이름
#[tauri::command]
pub fn device_name() -> String {
    this_device_name()
}

#[tauri::command]
pub fn peers_list(app: AppHandle) -> Vec<PeerView> {
    peer_views(&app.state::<RemoteManager>().peers_path)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInput {
    url: String,
    code: String,
    #[serde(default)]
    name: String,
}

/// 다른 PC 를 등록한다: 그 PC 의 화면에 뜬 6자리 코드로 이 PC 를 기기로 등록하고, 받은 토큰을 키체인에 둔다
#[tauri::command]
pub async fn peer_add(app: AppHandle, input: PeerInput) -> Result<Vec<PeerView>, String> {
    let url = normalize_peer_url(&input.url)?;
    let (http, path) = {
        let mgr = app.state::<RemoteManager>();
        (mgr.http.clone(), mgr.peers_path.clone())
    };
    // 등록 요청은 적은 주소로만 보낸다 — 다른 곳으로 넘기는 응답(redirect)을 따라가면 코드가 엉뚱한 곳에 다시 보내진다
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or(http);
    let res = http
        .post(format!("{url}/pair"))
        .timeout(Duration::from_secs(10))
        .json(&json!({ "code": input.code.trim(), "name": this_device_name() }))
        .send()
        .await
        .map_err(|e| format!("{url} 에 연결할 수 없습니다 — 주소와 그 PC 의 원격 접속이 켜져 있는지 확인하세요 ({e})"))?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        return Err(match (body.as_str(), v.get("error").and_then(Value::as_str)) {
            ("pair_not_open", _) => "등록 코드가 만료되었거나 이미 사용되었습니다 — 그 PC 의 [원격 접속] 에서 새 코드를 받으세요".into(),
            ("not_enabled", _) => "그 PC 의 원격 접속이 꺼져 있습니다".into(),
            (_, Some("pair_wrong_code")) => match v.get("left").and_then(Value::as_u64) {
                Some(n) if n > 0 => format!("코드가 맞지 않습니다(남은 시도 {n}번)"),
                _ => "코드를 여러 번 틀려 무효가 되었습니다 — 새 코드를 받으세요".into(),
            },
            _ => format!("등록하지 못했습니다({status})"),
        });
    }
    let token = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v.get("token").and_then(Value::as_str).map(str::to_string))
        .ok_or("그 PC 의 응답을 읽을 수 없습니다(minmo 가 아니거나 버전이 다릅니다)")?;
    let id: String = random_bytes::<8>()?
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    keychain::set(&peer_key(&id), &token)?;
    let name: String = input
        .name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect();
    let mut peers = load_peers(&path);
    // 같은 주소를 다시 등록하면 바꿔 넣는다(토큰이 새로 발급됐다). 옛 항목의 토큰·창은 목록을 저장한 뒤에 치운다
    let replaced: Vec<String> = peers
        .iter()
        .filter(|p| p.url == url)
        .map(|p| p.id.clone())
        .collect();
    peers.retain(|p| p.url != url);
    peers.push(Peer {
        id,
        name: if name.is_empty() { url.clone() } else { name },
        url,
    });
    if let Err(e) = save_peers(&path, &peers) {
        // 목록에 넣지 못했으면 방금 받은 토큰도 남기지 않는다
        let _ = keychain::delete(&peer_key(
            &peers.last().map(|p| p.id.clone()).unwrap_or_default(),
        ));
        return Err(e);
    }
    for old in replaced {
        let _ = keychain::delete(&peer_key(&old));
        close_peer_window(&app, &old);
    }
    Ok(peer_views(&path))
}

fn close_peer_window(app: &AppHandle, id: &str) {
    if let Some(win) = app.get_webview_window(&format!("peer-{id}")) {
        let _ = win.close();
    }
}

#[tauri::command]
pub fn peer_remove(app: AppHandle, id: String) -> Result<Vec<PeerView>, String> {
    let path = app.state::<RemoteManager>().peers_path.clone();
    let mut peers = load_peers(&path);
    peers.retain(|p| p.id != id);
    save_peers(&path, &peers)?;
    let _ = keychain::delete(&peer_key(&id));
    // 열어 둔 그 PC 의 창도 닫는다(토큰이 없으면 다시 붙지 못한다)
    close_peer_window(&app, &id);
    Ok(peer_views(&path))
}

/// 주소의 출처(scheme://host[:port]) — 비교용. 읽을 수 없으면 빈 글자(어느 것과도 같지 않게 쓰는 쪽에서 다룬다)
pub fn origin_of(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return String::new();
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        return String::new();
    }
    format!(
        "{}://{}",
        scheme.to_ascii_lowercase(),
        host.to_ascii_lowercase()
    )
}

/// 주소의 # 뒤에 넣을 값 — 글자·숫자와 `-_.~` 만 그대로 두고 나머지는 %XX 로 바꾼다
fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// 다른 PC 의 화면 주소. 기기 토큰과 "열 곳"은 # 뒤에 붙인다 — # 뒤는 서버로 보내지지 않고,
/// 그 화면(desktop/src/features/remote/deepLink.ts)이 읽은 뒤 주소에서 지운다.
pub fn peer_url(base: &str, token: &str, open: Option<&Value>, nonce: u64) -> String {
    let mut hash = format!("device={}", percent_encode(token));
    if let Some(o) = open {
        // n: 같은 곳을 다시 열어도 주소가 달라져 그 화면이 다시 처리한다
        hash.push_str(&format!(
            "&open={}&n={nonce}",
            percent_encode(&o.to_string())
        ));
    }
    format!("{base}/#{hash}")
}

/// 다른 PC 의 화면을 별도 창으로 연다(이미 열려 있으면 그 창을 앞으로 가져오고, open 이 있으면 그곳으로 간다).
/// 앱 화면 안의 틀(iframe)에 넣지 않는 이유: 브라우저 엔진이 앱 화면에서 사설 네트워크 주소의 틀을 여는 것을 막는다.
/// 이 창은 그 PC 가 내준 화면이며 이 앱의 네이티브 명령을 부를 수 없다(권한은 main 창에만 있다).
/// async 여야 한다 — Windows 에서는 메인 스레드(동기 명령)에서 창을 만들면 멈춘다.
#[tauri::command]
pub async fn peer_open(app: AppHandle, id: String, open: Option<Value>) -> Result<(), String> {
    let path = app.state::<RemoteManager>().peers_path.clone();
    let peer = load_peers(&path)
        .into_iter()
        .find(|p| p.id == id)
        .ok_or("등록되지 않은 PC 입니다")?;
    let token = keychain::get(&peer_key(&peer.id))?
        .ok_or("그 PC 의 등록 정보를 읽을 수 없습니다 — [원격 접속] 에서 지우고 다시 등록하세요")?;
    let url = peer_url(&peer.url, &token, open.as_ref(), now_ms());
    let label = format!("peer-{}", peer.id);
    let origin = origin_of(&peer.url);
    if let Some(win) = app.get_webview_window(&label) {
        // 그 창이 아직 그 PC 의 화면을 보이고 있을 때만 알린다(토큰이 든 주소를 다른 화면에 넣지 않는다)
        let on_peer = win
            .url()
            .ok()
            .is_some_and(|u| origin_of(u.as_str()) == origin);
        if open.is_some() && on_peer {
            // 이미 떠 있는 화면에는 # 뒤만 바꿔 알린다(다시 불러오지 않는다)
            let hash = url.split_once('#').map_or("", |(_, h)| h);
            let js = format!(
                "location.hash = {}",
                serde_json::to_string(hash).map_err(|e| e.to_string())?
            );
            win.eval(&js).map_err(|e| e.to_string())?;
        }
        let _ = win.unminimize();
        let _ = win.show();
        return win.set_focus().map_err(|e| e.to_string());
    }
    let parsed = url
        .parse()
        .map_err(|e| format!("주소가 올바르지 않습니다: {e}"))?;
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(parsed))
        .title(format!("minmo — {}", peer.name))
        .inner_size(1280.0, 800.0)
        .min_inner_size(600.0, 400.0)
        // 이 창은 그 PC 의 주소 안에서만 움직인다 — 그 PC 의 화면이 이 창을 이 앱의 화면(http://tauri.localhost 등)이나
        // 다른 사이트로 보내지 못하게 한다. 이 앱의 주소로 가면 그 창이 본창처럼 네이티브 명령을 쓸 수 있게 된다
        .on_navigation(move |u| origin_of(u.as_str()) == origin)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 화면이 맡은 호출의 결과를 돌려준다
#[tauri::command]
pub fn remote_rpc_reply(app: AppHandle, id: u64, ok: bool, value: Value) {
    let tx = app
        .state::<RemoteManager>()
        .pending
        .lock()
        .ok()
        .and_then(|mut p| p.remove(&id));
    if let Some(tx) = tx {
        let _ = tx.send(if ok {
            Ok(value)
        } else {
            Err(value.as_str().unwrap_or("호출에 실패했습니다").to_string())
        });
    }
}

#[tauri::command]
pub fn shared_get(app: AppHandle, key: String) -> Result<SharedValue, String> {
    app.state::<RemoteManager>().shared_get(&key)
}

#[tauri::command]
pub fn shared_set(
    app: AppHandle,
    key: String,
    value: String,
    origin: String,
    base: u64,
) -> Result<u64, String> {
    app.state::<RemoteManager>()
        .shared_set(&app, &key, &value, &origin, base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_urls_are_normalized_to_scheme_host_port() {
        let ok = |i: &str| normalize_peer_url(i).unwrap();
        assert_eq!(ok("100.64.0.5"), "http://100.64.0.5:8790");
        assert_eq!(ok(" http://my-pc:9000/ "), "http://my-pc:9000");
        assert_eq!(
            ok("HTTPS://my-pc.tail1234.ts.net/some/path?x=1"),
            "https://my-pc.tail1234.ts.net"
        );
        assert_eq!(ok("my-pc"), "http://my-pc:8790");
        for bad in [
            "",
            "ftp://x",
            "http://",
            "http://user@host",
            "http://a b",
            "javascript:alert(1)",
        ] {
            assert!(normalize_peer_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn peer_window_url_carries_token_and_target_in_the_fragment_only() {
        assert_eq!(
            peer_url("http://100.64.0.5:8790", "tok_en-1", None, 7),
            "http://100.64.0.5:8790/#device=tok_en-1"
        );
        let open =
            json!({ "target": { "owner": "a", "title": "로그인 & 가입" }, "paneId": "a/b#1::2" });
        let url = peer_url("http://h:1", "t", Some(&open), 7);
        let (base, hash) = url.split_once('#').unwrap();
        assert_eq!(base, "http://h:1/");
        assert!(hash.starts_with("device=t&open=%7B") && hash.ends_with("&n=7"));
        // 값 안의 & # 공백·한글이 주소를 깨지 않는다
        let value = hash
            .strip_prefix("device=t&open=")
            .unwrap()
            .strip_suffix("&n=7")
            .unwrap();
        assert!(value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.~%".contains(c)));
        assert_eq!(percent_encode("a b&c#d"), "a%20b%26c%23d");
    }

    #[test]
    fn peer_window_stays_on_the_peer_origin() {
        let peer = origin_of("http://100.64.0.5:8790");
        assert_eq!(peer, "http://100.64.0.5:8790");
        assert_eq!(origin_of("http://100.64.0.5:8790/some/path#device=x"), peer);
        assert_eq!(origin_of("HTTP://MY-PC:8790/"), "http://my-pc:8790");
        // 이 앱의 화면·다른 사이트·다른 포트는 그 PC 의 주소가 아니다
        for other in [
            "http://tauri.localhost/",
            "tauri://localhost",
            "https://100.64.0.5:8790/",
            "http://100.64.0.5:8791/",
            "http://evil.example/",
            "about:blank",
            "",
        ] {
            assert_ne!(origin_of(other), peer, "{other}");
        }
    }

    #[test]
    fn served_index_is_marked_as_remote() {
        assert!(String::from_utf8(mark_remote(
            b"<html><head lang=\"ko\"><title>x</title></head></html>"
        ))
        .unwrap()
        .contains("<head lang=\"ko\"><meta name=\"minmo-runtime\""));
        let out = String::from_utf8(mark_remote(
            b"<!doctype html><html><head><title>x</title></head></html>",
        ))
        .unwrap();
        assert_eq!(
            out,
            format!("<!doctype html><html><head>{REMOTE_MARK}<title>x</title></head></html>")
        );
        assert_eq!(mark_remote(b"no head here"), b"no head here");
    }

    #[test]
    fn peers_file_round_trips_without_tokens() {
        let dir = std::env::temp_dir().join(format!("minmo-peers-test-{}", now_ms()));
        let path = dir.join("peers.json");
        assert!(load_peers(&path).is_empty());
        let peers = vec![Peer {
            id: "a1".into(),
            name: "회사 PC".into(),
            url: "http://100.64.0.5:8790".into(),
        }];
        save_peers(&path, &peers).unwrap();
        assert_eq!(load_peers(&path), peers);
        // 토큰은 키체인에만 둔다 — 파일에는 없다
        assert!(!std::fs::read_to_string(&path).unwrap().contains("token"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pairing_code_is_single_use_and_locks_after_wrong_tries() {
        let p = Pairings::default();
        assert_eq!(p.redeem("000000"), Err(PairError::NotOpen));
        let code = p.start().unwrap();
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(p.redeem(&format!(" {code} ")), Ok(()));
        // 한 번 쓴 코드는 다시 쓸 수 없다
        assert_eq!(p.redeem(&code), Err(PairError::NotOpen));

        let code = p.start().unwrap();
        let wrong = if code == "111111" { "222222" } else { "111111" };
        for left in (1..PAIR_MAX_FAILS).rev() {
            assert_eq!(p.redeem(wrong), Err(PairError::Wrong(left)));
        }
        assert_eq!(p.redeem(wrong), Err(PairError::Wrong(0)));
        // 여러 번 틀리면 맞는 코드도 통하지 않는다
        assert_eq!(p.redeem(&code), Err(PairError::NotOpen));

        p.start().unwrap();
        p.cancel();
        assert_eq!(p.redeem("123456"), Err(PairError::NotOpen));
    }

    #[test]
    fn pairing_code_expires() {
        let p = Pairings::default();
        let code = p.start().unwrap();
        p.0.lock().unwrap().as_mut().unwrap().expires = Instant::now() - Duration::from_secs(1);
        assert_eq!(p.redeem(&code), Err(PairError::NotOpen));
    }

    #[test]
    fn only_listens_on_loopback_tailscale_and_opted_in_lan() {
        let ts = Ipv4Addr::new(100, 101, 102, 103);
        let all = [
            Ipv4Addr::new(192, 168, 0, 10),
            ts,
            Ipv4Addr::new(8, 8, 8, 8),
            // 통신사 NAT(테더링 등) — Tailscale 과 같은 대역이지만 tailscale 이 알려 준 주소가 아니다
            Ipv4Addr::new(100, 70, 1, 2),
            Ipv4Addr::new(10, 0, 0, 5),
        ];
        let kinds = |tailscale: &[Ipv4Addr], lan| {
            pick_addrs(&all, tailscale, lan)
                .into_iter()
                .map(|(ip, k)| format!("{ip}={k}"))
                .collect::<Vec<_>>()
        };
        // 공인 주소(8.8.8.8)와 통신사 NAT 주소(100.70.1.2)에는 열지 않는다
        assert_eq!(
            kinds(&[ts], false),
            ["100.101.102.103=tailscale", "127.0.0.1=local"]
        );
        assert_eq!(
            kinds(&[ts], true),
            [
                "10.0.0.5=lan",
                "100.101.102.103=tailscale",
                "127.0.0.1=local",
                "192.168.0.10=lan"
            ]
        );
        // tailscale 을 확인할 수 없으면 그 대역의 주소에는 열지 않는다
        assert_eq!(kinds(&[], false), ["127.0.0.1=local"]);
        assert!(is_cgnat(&ts) && !is_cgnat(&Ipv4Addr::new(100, 128, 0, 1)));
    }

    #[test]
    fn host_header_must_be_an_ip_a_bare_name_or_a_tailnet_name() {
        for h in [
            "127.0.0.1:8790",
            "100.101.102.103:8790",
            "192.168.0.10",
            "localhost:8790",
            "my-pc:8790",
            "my-pc.tail1234.ts.net",
            "MY-PC.Tail1234.TS.NET:443",
            "[::1]:8790",
        ] {
            assert!(host_allowed(h), "{h}");
        }
        // 다른 도메인이 이 PC 를 가리키게 한 경우(DNS rebinding)
        for h in [
            "evil.com:8790",
            "127.0.0.1.evil.com",
            "ts.net.evil.com:8790",
            "evil.com",
            "",
        ] {
            assert!(!host_allowed(h), "{h}");
        }
    }

    #[test]
    fn remote_cannot_call_host_only_commands_or_read_tokens() {
        let none = json!([]);
        for m in [
            "ptySpawn",
            "ptyFind",
            "ptyWrite",
            "gitRun",
            "readTextFile",
            "sharedSet",
        ] {
            assert!(allowed(m, &none), "{m}");
        }
        for m in [
            "keychainGet",
            "keychainSet",
            "serverSettingsSave",
            "appClose",
            "appUpdateInstall",
            "openDir",
            "openUrl",
            "pickFolder",
            "sshHostSave",
            "remoteConfigure",
            "remotePairStart",
            "remoteRpcReply",
            "nope",
        ] {
            assert!(!allowed(m, &none), "{m}");
        }
        assert!(allowed("ghRun", &json!([["pr", "list"]])));
        assert!(!allowed("ghRun", &json!([["auth", "token"]])));

        let (get, put, post, delete) = (Method::GET, Method::PUT, Method::POST, Method::DELETE);
        for (m, p) in [
            (&get, "/me"),
            (&get, "/me/visible-repos"),
            (&put, "/me/visible-repos"),
            (&get, "/settings"),
            (&put, "/orgs/acme/settings"),
            (&get, "/projects/acme/app/settings/effective"),
            (&put, "/projects/_local/my-app-1a2b/issues/etc/notes"),
        ] {
            assert!(api_request_allowed(m, p), "{m} {p}");
        }
        for (m, p) in [
            // 토큰·세션·로그인·CLI 코드
            (&get, "/me/github-token"),
            (&get, "/me/sessions"),
            (&delete, "/me/sessions/abc"),
            (&post, "/me/cli-codes"),
            (&post, "/auth/github/device/start"),
            (&post, "/auth/cli/exchange"),
            (&delete, "/auth/session"),
            // 서버가 다르게 풀이할 수 있는 모양
            (&get, "/./me/github-token"),
            (&get, "/me/../me/github-token"),
            (&get, "/me/%67ithub-token"),
            (&get, "//me"),
            (&get, "/me/"),
            (&get, "me"),
            (&get, "/projects/a/b/settings/../../../../me/github-token"),
            // 허용한 경로라도 다른 메서드는 안 된다
            (&put, "/me"),
            (&delete, "/settings"),
            (&post, "/projects/a/b/issues/1/notes"),
            (&get, "/healthz"),
        ] {
            assert!(!api_request_allowed(m, p), "{m} {p}");
        }
    }

    #[test]
    fn device_tokens_are_stored_hashed_and_removed_devices_stop_working() {
        let dir = std::env::temp_dir().join(format!("minmo-remote-test-{}", now_ms()));
        let mgr = RemoteManager::new(&dir);
        mgr.update(|c| {
            c.enabled = true;
            c.devices.push(Device {
                id: "d1".into(),
                name: "폰".into(),
                hash: hash_token("secret-token"),
                created_ms: 1,
                last_seen_ms: 1,
            });
        })
        .unwrap();
        assert_eq!(mgr.device_of("secret-token").as_deref(), Some("d1"));
        assert_eq!(mgr.device_of("other"), None);
        let saved = std::fs::read_to_string(dir.join("remote.json")).unwrap();
        assert!(!saved.contains("secret-token"));
        // 다시 읽어도 같다
        assert_eq!(load_config(&dir.join("remote.json")), mgr.config());
        // 원격 접속을 끄면 등록된 기기도 통하지 않는다
        mgr.update(|c| c.enabled = false).unwrap();
        assert_eq!(mgr.device_of("secret-token"), None);
        mgr.update(|c| {
            c.enabled = true;
            c.devices.clear();
        })
        .unwrap();
        assert_eq!(mgr.device_of("secret-token"), None);
        assert!(!mgr.device_exists("d1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn shared_state_names_are_restricted_and_values_round_trip() {
        let dir = std::env::temp_dir().join(format!("minmo-shared-test-{}", now_ms()));
        let mgr = RemoteManager::new(&dir);
        assert!(mgr.shared_path("repos").is_ok());
        for bad in ["", "../x", "a/b", "A", "a.b"] {
            assert!(mgr.shared_path(bad).is_err(), "{bad}");
        }
        let empty = mgr.shared_get("repos").unwrap();
        assert_eq!((empty.value, empty.rev), (None, 0));

        // 저장할 때마다 판 번호가 오르고, 마지막으로 본 판이 지금과 다르면 거절한다(다른 화면의 변경을 덮어쓰지 않게)
        assert_eq!(mgr.shared_store("repos", r#"{"n":1}"#, 0), Ok(1));
        assert_eq!(mgr.shared_store("repos", r#"{"n":2}"#, 1), Ok(2));
        assert_eq!(
            mgr.shared_store("repos", r#"{"n":3}"#, 1),
            Err(SHARED_CONFLICT.to_string())
        );
        let now = mgr.shared_get("repos").unwrap();
        assert_eq!((now.value.as_deref(), now.rev), (Some(r#"{"n":2}"#), 2));
        // 판 번호는 이름마다 따로다
        assert_eq!(mgr.shared_store("ui", "{}", 0), Ok(1));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
