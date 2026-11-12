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
];
/// 붙은 기기에 전달하는 앱 이벤트
const FORWARDED_EVENTS: &[&str] = &[
    "pty-data",
    "pty-exit",
    "pty-resized",
    "script-log",
    "shared-changed",
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

/// 열 주소를 고른다: 127.0.0.1 + Tailscale(100.64.0.0/10) + (lan 이면) 사설 LAN. 공인 주소에는 열지 않는다
pub fn pick_addrs(all: &[Ipv4Addr], lan: bool) -> Vec<(Ipv4Addr, &'static str)> {
    let mut out = vec![(Ipv4Addr::LOCALHOST, "local")];
    for ip in all {
        let o = ip.octets();
        let tailscale = o[0] == 100 && (o[1] & 0xc0) == 64;
        if tailscale {
            out.push((*ip, "tailscale"));
        } else if lan && ip.is_private() {
            out.push((*ip, "lan"));
        }
    }
    out.sort();
    out.dedup();
    out
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
    /// 화면(웹뷰)에 맡긴 호출의 응답 대기
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    seq: AtomicU64,
    /// 기기 id → 붙어 있는 연결 수
    connected: Mutex<HashMap<String, u32>>,
    http: reqwest::Client,
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
            pending: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
            connected: Mutex::new(HashMap::new()),
            http: reqwest::Client::new(),
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
            pick_addrs(&interface_addrs(), c.lan)
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
            pick_addrs(&interface_addrs(), c.lan)
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

    pub fn shared_get(&self, key: &str) -> Result<Option<String>, String> {
        match std::fs::read_to_string(self.shared_path(key)?) {
            Ok(t) => Ok(Some(t)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn shared_set(
        &self,
        app: &AppHandle,
        key: &str,
        value: &str,
        origin: &str,
    ) -> Result<(), String> {
        let path = self.shared_path(key)?;
        std::fs::create_dir_all(&self.shared_dir).map_err(|e| e.to_string())?;
        // 임시 파일에 쓰고 바꿔치기 — 쓰는 도중 꺼져도 반쯤 쓴 파일이 남지 않는다
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, value).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        // 다른 화면(이 PC 의 창·붙은 기기)이 다시 읽게 알린다. origin 은 바꾼 화면 — 자기 것은 다시 읽지 않는다
        let _ = app.emit("shared-changed", json!({ "key": key, "origin": origin }));
        Ok(())
    }
}

/// 앱 시작 시: 설정을 읽고, 이벤트 전달과 주기적인 주소 확인을 건다
pub fn init(app: &AppHandle) {
    let Ok(dirs) = profile::dirs(app) else {
        return;
    };
    app.manage(RemoteManager::new(&dirs.config));
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

async fn ws_upgrade(AxState(ctx): AxState<Ctx>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(MAX_BODY)
        .on_upgrade(move |socket| ws_session(ctx, socket))
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
        "sharedSet" => ok(ctx.mgr().shared_set(
            app,
            &arg::<String>(&args, 0)?,
            &arg::<String>(&args, 1)?,
            &arg::<String>(&args, 2)?,
        )),
        _ => {
            // 원격 화면은 GitHub 토큰 대신 표식을 보낸다 — 여기서 실제 토큰으로 바꾼다
            let args = substitute_token(ctx, args).await;
            ctx.mgr().call_webview(app, method, args).await
        }
    }
}

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

/// 원격 화면이 부를 수 없는 서버 경로 — 로그인(이 PC 에서 한다)과 토큰을 그대로 돌려주는 것
pub fn api_path_allowed(path: &str) -> bool {
    let p = path.trim_start_matches('/');
    !(p.starts_with("auth/")
        || p == "auth"
        || p.starts_with("me/github-token")
        || p.starts_with("sessions"))
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
    if !api_path_allowed(rest.split('?').next().unwrap_or("")) {
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
    let url = format!("https://api.github.com{}", path_and_query(&req, "/gh"));
    forward(&ctx, req, url, token, true).await
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
    let mut resp = Response::new(Body::from(a.bytes));
    if let Ok(v) = HeaderValue::from_str(&a.mime_type) {
        resp.headers_mut().insert(header::CONTENT_TYPE, v);
    }
    let h = resp.headers_mut();
    // 화면 파일은 이름에 해시가 붙는다 — index.html 만 매번 새로 받는다
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if is_index {
            "no-cache"
        } else {
            "public, max-age=31536000, immutable"
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
pub fn shared_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    app.state::<RemoteManager>().shared_get(&key)
}

#[tauri::command]
pub fn shared_set(
    app: AppHandle,
    key: String,
    value: String,
    origin: String,
) -> Result<(), String> {
    app.state::<RemoteManager>()
        .shared_set(&app, &key, &value, &origin)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let all = [
            Ipv4Addr::new(192, 168, 0, 10),
            Ipv4Addr::new(100, 101, 102, 103),
            Ipv4Addr::new(8, 8, 8, 8),
            Ipv4Addr::new(100, 128, 0, 1),
            Ipv4Addr::new(10, 0, 0, 5),
        ];
        let kinds = |lan| {
            pick_addrs(&all, lan)
                .into_iter()
                .map(|(ip, k)| format!("{ip}={k}"))
                .collect::<Vec<_>>()
        };
        // 공인 주소(8.8.8.8)와 CGNAT 밖의 100.x(100.128.0.1)에는 열지 않는다
        assert_eq!(
            kinds(false),
            ["100.101.102.103=tailscale", "127.0.0.1=local"]
        );
        assert_eq!(
            kinds(true),
            [
                "10.0.0.5=lan",
                "100.101.102.103=tailscale",
                "127.0.0.1=local",
                "192.168.0.10=lan"
            ]
        );
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

        assert!(api_path_allowed("/me"));
        assert!(api_path_allowed("/issues/acme/app/1/note"));
        for p in [
            "/me/github-token",
            "/auth/github/device/start",
            "/auth/cli/exchange",
            "/sessions",
        ] {
            assert!(!api_path_allowed(p), "{p}");
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
        assert_eq!(mgr.shared_get("repos").unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
