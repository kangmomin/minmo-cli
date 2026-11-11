// 원격 호스트(SSH 프로필) — 이 PC 의 ssh 로 ~/.ssh/config 의 Host 별칭에 접속해 명령을 실행한다.
// 원격에는 POSIX 셸과 git 만 있으면 된다(minmo CLI·역터널 불필요). 키·ProxyJump 등은 사용자의 ssh 설정을 그대로 따른다.
// 명령 실행은 BatchMode 라 프롬프트(비밀번호·호스트 키 확인)가 필요하면 멈추지 않고 실패한다.
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;

use super::git::CmdResult;
use super::script::{pump, safe_name, ScriptRunResult};

/// 호스트별 동시 ssh 연결 수 — 연결을 재사용하지 못하므로(Windows OpenSSH 는 ControlMaster 미지원) sshd 의
/// MaxStartups(기본 10)에 걸리지 않게 줄 세운다
const MAX_PARALLEL: usize = 4;
const INCLUDE_DEPTH: usize = 5;

#[derive(Default)]
pub struct SshState {
    sems: Mutex<HashMap<String, Arc<Semaphore>>>,
    /// runId → (host, 로컬 ssh pid)
    scripts: Mutex<HashMap<String, (String, u32)>>,
    cancelled: Mutex<HashSet<String>>,
}

impl SshState {
    fn sem(&self, host: &str) -> Arc<Semaphore> {
        let mut map = self.sems.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(host.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_PARALLEL)))
            .clone()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    pub alias: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    /// config = ~/.ssh/config 의 Host, app = 앱에 직접 등록한 호스트
    pub source: &'static str,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

/// 앱에 직접 등록한 호스트(ssh-hosts.json). 비밀번호는 저장하지 않는다 — 키 파일 또는 ssh-agent 로 접속한다
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppHost {
    pub alias: String,
    pub host_name: String,
    pub user: String,
    pub port: u16,
    #[serde(default)]
    pub identity_file: Option<String>,
}

struct AppHosts {
    path: PathBuf,
    hosts: Mutex<Vec<AppHost>>,
}

static APP_HOSTS: OnceLock<AppHosts> = OnceLock::new();

pub(crate) fn load_app_hosts(path: &Path) -> Vec<AppHost> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<AppHost>>(&t).ok())
        .unwrap_or_default()
}

pub(crate) fn store_app_hosts(path: &Path, hosts: &[AppHost]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(hosts).map_err(|e| e.to_string())?;
    // 쓰다가 끊겨도 기존 목록이 깨지지 않게 임시 파일에 쓴 뒤 바꾼다
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 앱 시작 시 한 번 — 설정 폴더의 등록 호스트를 읽는다
pub fn init(config_dir: &Path) {
    let path = config_dir.join("ssh-hosts.json");
    let hosts = load_app_hosts(&path);
    let _ = APP_HOSTS.set(AppHosts {
        path,
        hosts: Mutex::new(hosts),
    });
}

fn app_hosts() -> Vec<AppHost> {
    APP_HOSTS
        .get()
        .map(|a| a.hosts.lock().unwrap_or_else(|e| e.into_inner()).clone())
        .unwrap_or_default()
}

fn word(s: &str, extra: &[char]) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
}

fn expand_home(path: &str) -> PathBuf {
    match (
        path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")),
        home_dir(),
    ) {
        (Some(rest), Some(h)) => h.join(rest),
        _ => PathBuf::from(path),
    }
}

/// 등록할 호스트 검증 — 값이 ssh 옵션이나 다른 호스트로 해석되지 않게 한다. 정리한 값을 돌려준다
pub(crate) fn check_app_host(h: &AppHost, config_aliases: &[String]) -> Result<AppHost, String> {
    let alias = h.alias.trim().to_string();
    if !word(&alias, &['.', '_', '-']) {
        return Err("이름은 영문·숫자와 . _ - 만 쓸 수 있습니다".into());
    }
    if config_aliases.contains(&alias) {
        return Err(format!(
            "~/.ssh/config 에 같은 이름의 Host 가 있습니다: {alias}"
        ));
    }
    let host_name = h.host_name.trim().to_string();
    // ':' 는 IPv6 주소용
    if !word(&host_name, &['.', '_', '-', ':']) {
        return Err("호스트 주소가 올바르지 않습니다".into());
    }
    let user = h.user.trim().to_string();
    if !word(&user, &['.', '_', '-']) {
        return Err("사용자 이름이 올바르지 않습니다".into());
    }
    if h.port == 0 {
        return Err("포트는 1~65535 사이여야 합니다".into());
    }
    let identity_file = match h.identity_file.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(p) => {
            // 따옴표는 옵션 값의 인용을 깬다
            if p.contains('"') {
                return Err("키 파일 경로에 따옴표를 쓸 수 없습니다".into());
            }
            if !expand_home(p).is_file() {
                return Err(format!("키 파일을 찾을 수 없습니다: {p}"));
            }
            Some(p.to_string())
        }
    };
    Ok(AppHost {
        alias,
        host_name,
        user,
        port: h.port,
        identity_file,
    })
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    platform: &'static str,
    home: String,
    git: String,
    tmux: bool,
}

/// kind: host_key | auth | unreachable | unsupported_os | no_git | unknown_host | failed
#[derive(Debug, PartialEq, Serialize)]
pub struct SshError {
    kind: &'static str,
    message: String,
}

impl SshError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// debug 빌드만: E2E 가 사용자의 ~/.ssh/config 를 건드리지 않도록 다른 설정 파일을 쓴다
fn config_override() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        std::env::var_os("MINMO_SSH_CONFIG")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    } else {
        None
    }
}

fn config_path() -> Option<PathBuf> {
    config_override().or_else(|| home_dir().map(|h| h.join(".ssh").join("config")))
}

/// Windows 는 기본 제공 OpenSSH(Windows ssh-agent 를 쓴다)를 먼저 찾는다. Git 의 ssh 가 PATH 앞에 있어도
/// 사용자가 터미널(PowerShell)에서 쓰는 것과 같은 키·에이전트를 쓰게 하려는 것이다
pub(crate) fn ssh_program() -> PathBuf {
    if cfg!(windows) {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let p = PathBuf::from(root)
                .join("System32")
                .join("OpenSSH")
                .join("ssh.exe");
            if p.is_file() {
                return p;
            }
        }
    }
    PathBuf::from("ssh")
}

/// POSIX 셸의 작은따옴표 인용
pub(crate) fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn valid_env_name(k: &str) -> bool {
    let mut chars = k.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 원격 셸에 넘길 한 줄 명령: [cd -- cwd &&] exec [env K=V …] argv…
pub(crate) fn remote_command(
    argv: &[String],
    cwd: Option<&str>,
    env: &HashMap<String, String>,
) -> Result<String, String> {
    if argv.is_empty() {
        return Err("실행할 명령이 없습니다".into());
    }
    let mut out = String::new();
    if let Some(dir) = cwd {
        out.push_str(&format!("cd -- {} && ", quote(dir)));
    }
    out.push_str("exec ");
    if !env.is_empty() {
        out.push_str("env ");
        let mut keys: Vec<&String> = env.keys().collect();
        keys.sort();
        for k in keys {
            if !valid_env_name(k) {
                return Err(format!("환경 변수 이름이 올바르지 않습니다: {k}"));
            }
            out.push_str(&format!("{}={} ", k, quote(&env[k])));
        }
    }
    let words: Vec<String> = argv.iter().map(|a| quote(a)).collect();
    out.push_str(&words.join(" "));
    Ok(out)
}

/// 원격 로그인 셸이 POSIX 가 아니어도(fish·csh 등) 같은 문법으로 실행되게 sh 에 넘긴다
pub(crate) fn sh_wrap(command: &str) -> String {
    format!("sh -c {}", quote(command))
}

fn unquote(v: &str) -> &str {
    let v = v.trim();
    v.strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(v)
}

/// "Keyword value" 또는 "Keyword=value"
fn split_directive(line: &str) -> Option<(String, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let idx = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = line[..idx].to_ascii_lowercase();
    let rest = line[idx..].trim_start_matches(|c: char| c.is_whitespace() || c == '=');
    Some((key, rest))
}

/// `*`·`?` 만 지원하는 파일 이름 매칭(Include 용)
fn wildcard(pattern: &str, name: &str) -> bool {
    fn go(p: &[char], n: &[char]) -> bool {
        match p.split_first() {
            None => n.is_empty(),
            Some(('*', rest)) => (0..=n.len()).any(|i| go(rest, &n[i..])),
            Some(('?', rest)) => !n.is_empty() && go(rest, &n[1..]),
            Some((c, rest)) => n.first() == Some(c) && go(rest, &n[1..]),
        }
    }
    go(
        &pattern.chars().collect::<Vec<_>>(),
        &name.chars().collect::<Vec<_>>(),
    )
}

/// Include 대상 파일들 — 상대 경로는 설정 파일 폴더 기준, 와일드카드는 마지막 요소에서만 지원한다
fn include_targets(spec: &str, base: &Path, home: Option<&Path>) -> Vec<PathBuf> {
    let spec = unquote(spec);
    let expanded = match (spec.strip_prefix("~/"), home) {
        (Some(rest), Some(h)) => h.join(rest),
        _ => PathBuf::from(spec),
    };
    let path = if expanded.is_absolute() {
        expanded
    } else {
        base.join(expanded)
    };
    let name = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) => n.to_string(),
        None => return vec![],
    };
    if !name.contains(['*', '?']) {
        return vec![path];
    }
    let Some(dir) = path.parent() else {
        return vec![];
    };
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| wildcard(&name, &e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    found.sort();
    found
}

/// base: Include 의 상대 경로 기준 — ssh 처럼 포함된 파일이 아니라 최상위 설정 파일의 폴더(~/.ssh)
fn parse_into(path: &Path, base: &Path, home: Option<&Path>, depth: usize, out: &mut Vec<SshHost>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    // 지금 블록에 속한 호스트들의 out 내 위치
    let mut current: Vec<usize> = Vec::new();
    for line in text.lines() {
        let Some((key, value)) = split_directive(line) else {
            continue;
        };
        match key.as_str() {
            "host" => {
                current.clear();
                for alias in value.split_whitespace().map(unquote) {
                    // 패턴(*, ?, !부정)은 접속 대상이 아니다
                    // '|' 는 호스트별 worktree id(ssh:<별칭>|…)의 구분자라 받지 않는다
                    if alias.is_empty()
                        || alias.contains(['*', '?', '!', '|'])
                        || alias.starts_with('-')
                    {
                        continue;
                    }
                    let idx = match out.iter().position(|h| h.alias == alias) {
                        Some(i) => i,
                        None => {
                            out.push(SshHost {
                                alias: alias.to_string(),
                                host_name: None,
                                user: None,
                                source: "config",
                                port: None,
                                identity_file: None,
                            });
                            out.len() - 1
                        }
                    };
                    current.push(idx);
                }
            }
            "match" => current.clear(),
            // ssh 는 먼저 나온 값을 쓴다
            "hostname" => {
                for &i in &current {
                    out[i]
                        .host_name
                        .get_or_insert_with(|| unquote(value).to_string());
                }
            }
            "user" => {
                for &i in &current {
                    out[i]
                        .user
                        .get_or_insert_with(|| unquote(value).to_string());
                }
            }
            "include" if depth < INCLUDE_DEPTH => {
                for spec in value.split_whitespace() {
                    for target in include_targets(spec, base, home) {
                        parse_into(&target, base, home, depth + 1, out);
                    }
                }
            }
            _ => {}
        }
    }
}

pub(crate) fn parse_hosts(path: &Path, home: Option<&Path>) -> Vec<SshHost> {
    let mut out = Vec::new();
    let base = path.parent().unwrap_or(Path::new("."));
    parse_into(path, base, home, 0, &mut out);
    out
}

fn config_hosts() -> Vec<SshHost> {
    match config_path() {
        Some(p) => parse_hosts(&p, home_dir().as_deref()),
        None => vec![],
    }
}

/// ~/.ssh/config 의 Host + 앱에 등록한 호스트. 이름이 겹치면 설정 파일 쪽을 쓴다
fn merge_hosts(mut hosts: Vec<SshHost>, app: Vec<AppHost>) -> Vec<SshHost> {
    for a in app {
        if hosts.iter().any(|h| h.alias == a.alias) {
            continue;
        }
        hosts.push(SshHost {
            alias: a.alias,
            host_name: Some(a.host_name),
            user: Some(a.user),
            source: "app",
            port: Some(a.port),
            identity_file: a.identity_file,
        });
    }
    hosts
}

fn list_hosts() -> Vec<SshHost> {
    merge_hosts(config_hosts(), app_hosts())
}

/// 앱에 등록한 호스트면 그 정보(설정 파일의 Host 면 None) — 접속 옵션을 만드는 데 쓴다
fn app_host(host: &str) -> Option<AppHost> {
    if config_hosts().iter().any(|h| h.alias == host) {
        return None;
    }
    app_hosts().into_iter().find(|h| h.alias == host)
}

/// 아는 호스트(설정 파일의 별칭 또는 앱에 등록한 호스트)만 허용한다 — 웹뷰가 넘긴 값이 ssh 옵션(-o ProxyCommand=…)으로
/// 해석되지 않게
pub(crate) fn validate_host(host: &str) -> Result<(), String> {
    if list_hosts().iter().any(|h| h.alias == host) {
        Ok(())
    } else {
        Err(format!("등록되지 않은 호스트입니다: {host}"))
    }
}

/// IdentityFile 옵션 값. ssh 는 옵션 값을 설정 줄처럼 읽는다 — 공백이 있는 경로는 따옴표로 묶고, `%` 는 토큰(%h 등)으로
/// 풀리지 않게 `%%` 로 쓴다
pub(crate) fn identity_option(path: &str) -> String {
    format!("IdentityFile=\"{}\"", path.replace('%', "%%"))
}

/// 앱에 등록한 호스트의 접속 옵션. 사용자 ssh 설정의 `Host *` 기본값은 그대로 적용된다
pub(crate) fn app_host_options(h: &AppHost) -> Vec<String> {
    let mut o = vec![
        "-o".to_string(),
        format!("HostName={}", h.host_name),
        "-o".to_string(),
        format!("User={}", h.user),
        "-o".to_string(),
        format!("Port={}", h.port),
    ];
    if let Some(key) = &h.identity_file {
        o.push("-o".into());
        o.push(identity_option(&expand_home(key).to_string_lossy()));
        o.push("-o".into());
        o.push("IdentitiesOnly=yes".into());
    }
    o
}

/// ssh 인자(원격 명령 앞까지). batch=true 는 프롬프트 없이 실패하는 명령 실행용, false 는 터미널용
pub(crate) fn ssh_args(host: &str, batch: bool) -> Vec<String> {
    ssh_args_for(host, app_host(host).as_ref(), batch, false)
}

/// accept_new: 처음 보는 호스트 키를 known_hosts 에 등록한다(이미 등록된 키가 바뀐 경우는 여전히 거부된다)
pub(crate) fn ssh_args_for(
    host: &str,
    app: Option<&AppHost>,
    batch: bool,
    accept_new: bool,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(h) = app {
        args.extend(app_host_options(h));
    }
    if accept_new {
        args.push("-o".into());
        args.push("StrictHostKeyChecking=accept-new".into());
    }
    if let Some(cfg) = config_override() {
        args.push("-F".into());
        args.push(cfg.to_string_lossy().into_owned());
    }
    if batch {
        args.extend(
            ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
                .iter()
                .map(|s| s.to_string()),
        );
    } else {
        args.push("-t".into());
    }
    args.extend(
        [
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "--",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    args.push(host.to_string());
    args
}

/// ssh 자체가 실패했을 때(종료 코드 255)의 stderr → 원인
pub(crate) fn classify(stderr: &str) -> SshError {
    let s = stderr.to_ascii_lowercase();
    let last = stderr
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("ssh 연결 실패")
        .to_string();
    let kind = if s.contains("host key verification failed")
        || s.contains("remote host identification has changed")
    {
        "host_key"
    } else if s.contains("permission denied") || s.contains("too many authentication failures") {
        "auth"
    } else if s.contains("could not resolve hostname")
        || s.contains("timed out")
        || s.contains("connection refused")
        || s.contains("no route to host")
        || s.contains("network is unreachable")
        || s.contains("connection closed")
        || s.contains("connection reset")
    {
        "unreachable"
    } else {
        "failed"
    };
    SshError::new(kind, last)
}

/// queued=false 는 줄을 서지 않는다 — 취소가 오래 걸리는 clone·fetch 뒤에서 기다리지 않게
async fn run_ssh(
    state: &SshState,
    host: &str,
    remote: String,
    stdin: Option<String>,
    queued: bool,
) -> Result<CmdResult, SshError> {
    run_ssh_with(state, host, remote, stdin, queued, false).await
}

async fn run_ssh_with(
    state: &SshState,
    host: &str,
    remote: String,
    stdin: Option<String>,
    queued: bool,
    accept_new: bool,
) -> Result<CmdResult, SshError> {
    validate_host(host).map_err(|m| SshError::new("unknown_host", m))?;
    let sem = state.sem(host);
    let _permit = if queued {
        Some(
            sem.acquire()
                .await
                .map_err(|e| SshError::new("failed", e.to_string()))?,
        )
    } else {
        None
    };
    let mut cmd = tokio::process::Command::new(ssh_program());
    cmd.args(ssh_args_for(
        host,
        app_host(host).as_ref(),
        true,
        accept_new,
    ))
    .arg(sh_wrap(&remote))
    .stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(super::CREATE_NO_WINDOW);
    let mut child = cmd
        .spawn()
        .map_err(|e| SshError::new("failed", format!("ssh 실행 실패: {e}")))?;
    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            // 원격 명령이 입력을 다 읽기 전에 끝나면 쓰기가 실패한다 — 결과는 종료 코드로 판단한다
            let _ = pipe.write_all(input.as_bytes()).await;
            drop(pipe);
        }
    }
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| SshError::new("failed", e.to_string()))?;
    let res = CmdResult {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    };
    // 255 는 ssh 자신의 실패(연결·인증) — 원격 명령의 실패와 구분한다
    if res.code == 255 {
        return Err(classify(&res.stderr));
    }
    Ok(res)
}

const PROBE: &str = r#"printf '%s\n' "os=$(uname -s)" "home=$HOME" "git=$(git --version 2>/dev/null)" "tmux=$(command -v tmux 2>/dev/null)""#;

pub(crate) fn parse_probe(stdout: &str) -> Result<Probe, SshError> {
    let field = |name: &str| {
        stdout
            .lines()
            .find_map(|l| l.trim_end_matches('\r').strip_prefix(name))
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let os = field("os=");
    let platform = match os.as_str() {
        "Linux" => "linux",
        "Darwin" => "darwin",
        _ => {
            return Err(SshError::new(
                "unsupported_os",
                if os.is_empty() {
                    "원격 OS 를 확인할 수 없습니다(POSIX 셸이 아님)".to_string()
                } else {
                    format!("지원하지 않는 OS: {os}")
                },
            ))
        }
    };
    let home = field("home=");
    if !home.starts_with('/') {
        return Err(SshError::new("failed", "원격 홈 폴더를 확인할 수 없습니다"));
    }
    let git = field("git=");
    if git.is_empty() {
        return Err(SshError::new("no_git", "원격에 git 이 없습니다"));
    }
    Ok(Probe {
        platform,
        home,
        git,
        tmux: !field("tmux=").is_empty(),
    })
}

#[tauri::command]
pub fn ssh_hosts() -> Vec<SshHost> {
    list_hosts()
}

/// trust_new: 처음 보는 호스트 키를 등록하고 연결한다(사용자가 [호스트 키 등록하고 연결] 을 눌렀을 때만)
#[tauri::command]
pub async fn ssh_probe(
    state: State<'_, SshState>,
    host: String,
    trust_new: Option<bool>,
) -> Result<Probe, SshError> {
    let res = run_ssh_with(
        &state,
        &host,
        PROBE.to_string(),
        None,
        true,
        trust_new.unwrap_or(false),
    )
    .await?;
    parse_probe(&res.stdout)
}

/// 호스트를 등록하거나 같은 이름의 등록을 고친다
#[tauri::command]
pub fn ssh_host_save(host: AppHost) -> Result<Vec<SshHost>, String> {
    let store = APP_HOSTS
        .get()
        .ok_or("호스트 저장소를 사용할 수 없습니다")?;
    let aliases: Vec<String> = config_hosts().into_iter().map(|h| h.alias).collect();
    let checked = check_app_host(&host, &aliases)?;
    {
        let mut hosts = lock(&store.hosts);
        match hosts.iter_mut().find(|h| h.alias == checked.alias) {
            Some(h) => *h = checked,
            None => hosts.push(checked),
        }
        store_app_hosts(&store.path, &hosts)?;
    }
    Ok(list_hosts())
}

#[tauri::command]
pub fn ssh_host_remove(alias: String) -> Result<Vec<SshHost>, String> {
    let store = APP_HOSTS
        .get()
        .ok_or("호스트 저장소를 사용할 수 없습니다")?;
    {
        let mut hosts = lock(&store.hosts);
        hosts.retain(|h| h.alias != alias);
        store_app_hosts(&store.path, &hosts)?;
    }
    Ok(list_hosts())
}

#[tauri::command]
pub async fn ssh_exec(
    state: State<'_, SshState>,
    host: String,
    argv: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    stdin: Option<String>,
) -> Result<CmdResult, String> {
    let remote = remote_command(&argv, cwd.as_deref(), &env.unwrap_or_default())?;
    run_ssh(&state, &host, remote, stdin, true)
        .await
        .map_err(|e| format!("ssh({}): {}", e.kind, e.message))
}

fn pid_file(run_id: &str) -> String {
    format!("\"$HOME\"/.minmo/run/{}.pid", safe_name(run_id))
}

/// 원격 스크립트 실행 명령.
/// - 스크립트는 stdin 으로 받아 파일로 저장한 뒤 실행한다 — 바로 `sh -s` 로 읽히면 스크립트 안의 명령(read·ssh·
///   docker run -i 등)이 stdin 으로 남은 줄을 먹어 뒷부분이 조용히 건너뛰어진다.
/// - sshd 는 명령을 새 세션(프로세스 그룹)으로 띄운다. 그 그룹 id 를 기록해 취소 때 그룹 전체에 신호를 보낸다
///   (로그인 셸이 exec 하지 않아 $$ 가 그룹 리더가 아닐 수 있어 ps 로 확인한다).
pub(crate) fn script_command(
    run_id: &str,
    cwd: &str,
    env: &HashMap<String, String>,
) -> Result<String, String> {
    let wrapper = r#"g=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' '); echo "${g:-$$}" > "$1"; cat > "$1.sh"; sh -e "$1.sh" < /dev/null; c=$?; rm -f "$1" "$1.sh"; exit $c"#;
    let pid = pid_file(run_id);
    let argv = [
        "sh".to_string(),
        "-c".to_string(),
        wrapper.to_string(),
        "sh".to_string(),
    ];
    let run = remote_command(&argv, None, env)?;
    Ok(format!(
        "mkdir -p \"$HOME\"/.minmo/run && cd -- {} && {} {}",
        quote(cwd),
        run,
        pid
    ))
}

pub(crate) fn cancel_command(run_id: &str) -> String {
    let pid = pid_file(run_id);
    // TERM 뒤 그룹이 끝나기를 3초까지 기다렸다가 남았으면 KILL 한다.
    // 그룹 지정은 `--` 없이 쓴다(busybox sh 의 kill 은 `--` 를 받지 않는다).
    // 시작 직후 취소하면 pid 파일이 아직 없을 수 있다 — 잠깐 기다렸다가 없으면(이미 끝남) 그만둔다
    format!(
        "i=0; while [ ! -s {pid} ] && [ $i -lt 15 ]; do sleep 0.2; i=$((i+1)); done; p=$(cat {pid} 2>/dev/null); [ -n \"$p\" ] || exit 0; kill -TERM -\"$p\" 2>/dev/null || kill -TERM \"$p\" 2>/dev/null; j=0; while kill -0 -\"$p\" 2>/dev/null && [ $j -lt 15 ]; do sleep 0.2; j=$((j+1)); done; kill -KILL -\"$p\" 2>/dev/null; rm -f {pid} {pid}.sh"
    )
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
pub async fn ssh_script_run(
    app: AppHandle,
    state: State<'_, SshState>,
    host: String,
    run_id: String,
    cwd: String,
    script: String,
    env: HashMap<String, String>,
) -> Result<ScriptRunResult, String> {
    if lock(&state.cancelled).remove(&run_id) {
        return Ok(ScriptRunResult::cancelled());
    }
    validate_host(&host)?;
    let remote = script_command(&run_id, &cwd, &env)?;
    let mut cmd = std::process::Command::new(ssh_program());
    cmd.args(ssh_args(&host, true))
        .arg(sh_wrap(&remote))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(super::CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("ssh 실행 실패: {e}"))?;
    lock(&state.scripts).insert(run_id.clone(), (host, child.id()));

    let stdin = child.stdin.take();
    let body = format!("{}\n", script.replace("\r\n", "\n"));
    let writer = std::thread::spawn(move || {
        if let Some(mut pipe) = stdin {
            let _ = pipe.write_all(body.as_bytes());
        }
    });
    let out = child
        .stdout
        .take()
        .map(|s| pump(app.clone(), run_id.clone(), "stdout", s));
    let err = child
        .stderr
        .take()
        .map(|s| pump(app.clone(), run_id.clone(), "stderr", s));
    // 시작 확인과 등록 사이에 취소가 들어왔으면 취소 쪽은 실행 중인 것을 보지 못했다 — 여기서 끝낸다
    if lock(&state.cancelled).contains(&run_id) {
        stop_running(&state, &run_id).await?;
    }
    let status = tauri::async_runtime::spawn_blocking(move || {
        let st = child.wait();
        let _ = writer.join();
        for h in [out, err].into_iter().flatten() {
            let _ = h.join();
        }
        st
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());

    lock(&state.scripts).remove(&run_id);
    if lock(&state.cancelled).remove(&run_id) {
        return Ok(ScriptRunResult::cancelled());
    }
    let code = status?.code().unwrap_or(-1);
    if code == 255 {
        return Err("ssh 연결이 끊겼거나 접속하지 못했습니다".into());
    }
    Ok(ScriptRunResult::exited(code))
}

#[tauri::command]
pub async fn ssh_script_cancel(state: State<'_, SshState>, run_id: String) -> Result<(), String> {
    lock(&state.cancelled).insert(run_id.clone());
    stop_running(&state, &run_id).await
}

/// 실행 중인 스크립트를 끝낸다(실행 중이 아니면 아무것도 하지 않는다)
async fn stop_running(state: &SshState, run_id: &str) -> Result<(), String> {
    let running = lock(&state.scripts).get(run_id).cloned();
    if let Some((host, pid)) = running {
        // 로컬 ssh 를 끊어도 원격 프로세스는 남는다(tty 없음) — 원격 그룹을 먼저 끝낸다
        let _ = run_ssh(state, &host, cancel_command(run_id), None, false).await;
        // 원격 취소를 기다리는 동안 로컬 ssh 가 이미 끝났으면 그 pid 는 다른 프로세스일 수 있다 — 아직 실행 중일 때만 끝낸다
        let still = lock(&state.scripts).get(run_id).map(|(_, p)| *p) == Some(pid);
        if still {
            tauri::async_runtime::spawn_blocking(move || super::script::kill_tree(pid))
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("minmo-ssh-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn quote_escapes_single_quotes() {
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), "'it'\\''s'");
        assert_eq!(quote("$(rm -rf /)"), "'$(rm -rf /)'");
    }

    #[test]
    fn remote_command_builds_cwd_env_and_args() {
        let env = HashMap::from([
            ("B".to_string(), "2 3".to_string()),
            ("A".to_string(), "1".to_string()),
        ]);
        let cmd = remote_command(
            &["git".into(), "-C".into(), "/w t".into(), "status".into()],
            Some("/home/u"),
            &env,
        )
        .unwrap();
        assert_eq!(
            cmd,
            "cd -- '/home/u' && exec env A='1' B='2 3' 'git' '-C' '/w t' 'status'"
        );
        assert_eq!(
            remote_command(&["true".into()], None, &HashMap::new()).unwrap(),
            "exec 'true'"
        );
    }

    #[test]
    fn remote_command_rejects_bad_input() {
        assert!(remote_command(&[], None, &HashMap::new()).is_err());
        let env = HashMap::from([("A;rm".to_string(), "1".to_string())]);
        assert!(remote_command(&["true".into()], None, &env).is_err());
    }

    #[test]
    fn parses_hosts_skipping_patterns_and_following_include() {
        let dir = tmp("parse");
        std::fs::create_dir_all(dir.join("conf.d")).unwrap();
        std::fs::write(
            dir.join("conf.d").join("work.conf"),
            "Host work\n  HostName=10.0.0.5\n  User dev\n",
        )
        .unwrap();
        std::fs::write(dir.join("conf.d").join("skip.txt"), "Host nope\n").unwrap();
        std::fs::write(
            dir.join("config"),
            "# 주석\nInclude conf.d/*.conf\nHost *\n  ForwardAgent no\nHost my-server alt !bad *.corp\n  hostname example.com\n  User me\n  User other\nMatch host x\n  User ignored\nHost \"quoted\"\n",
        )
        .unwrap();
        let hosts = parse_hosts(&dir.join("config"), None);
        let aliases: Vec<&str> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(aliases, ["work", "my-server", "alt", "quoted"]);
        assert_eq!(hosts[0].host_name.as_deref(), Some("10.0.0.5"));
        assert_eq!(hosts[0].user.as_deref(), Some("dev"));
        assert_eq!(hosts[1].host_name.as_deref(), Some("example.com"));
        assert_eq!(hosts[1].user.as_deref(), Some("me"));
        assert_eq!(hosts[3].user, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_aliases_with_the_id_separator() {
        let dir = tmp("pipe");
        std::fs::write(dir.join("config"), "Host ok \"a|b\"\n").unwrap();
        let hosts = parse_hosts(&dir.join("config"), None);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "ok");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nested_include_resolves_against_the_top_config_dir() {
        let dir = tmp("nested");
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::write(dir.join("config"), "Include a/one.conf\n").unwrap();
        std::fs::write(
            dir.join("a").join("one.conf"),
            "Include a/two.conf\nHost one\n",
        )
        .unwrap();
        std::fs::write(dir.join("a").join("two.conf"), "Host two\n").unwrap();
        let aliases: Vec<String> = parse_hosts(&dir.join("config"), None)
            .into_iter()
            .map(|h| h.alias)
            .collect();
        assert_eq!(aliases, ["two", "one"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sh_wrap_quotes_the_whole_command() {
        assert_eq!(sh_wrap("echo 'a b'"), "sh -c 'echo '\\''a b'\\'''");
    }

    #[test]
    fn missing_config_gives_no_hosts() {
        assert!(parse_hosts(Path::new("/nonexistent/minmo/config"), None).is_empty());
    }

    #[test]
    fn wildcard_matches() {
        assert!(wildcard("*.conf", "a.conf"));
        assert!(!wildcard("*.conf", "a.txt"));
        assert!(wildcard("h?st", "host"));
        assert!(wildcard("*", ""));
    }

    #[test]
    fn probe_parses_linux_and_mac() {
        let p = parse_probe("os=Linux\nhome=/home/u\ngit=git version 2.43.0\ntmux=/usr/bin/tmux\n")
            .unwrap();
        assert_eq!(p.platform, "linux");
        assert_eq!(p.home, "/home/u");
        assert_eq!(p.git, "git version 2.43.0");
        assert!(p.tmux);
        let p = parse_probe("os=Darwin\r\nhome=/Users/u\r\ngit=git version 2.39.5\r\ntmux=\r\n")
            .unwrap();
        assert_eq!(p.platform, "darwin");
        assert!(!p.tmux);
    }

    #[test]
    fn probe_reports_unsupported_os_and_missing_git() {
        assert_eq!(
            parse_probe("os=MINGW64_NT-10.0\nhome=/c/Users/u\ngit=x\ntmux=\n")
                .unwrap_err()
                .kind,
            "unsupported_os"
        );
        assert_eq!(parse_probe("garbage").unwrap_err().kind, "unsupported_os");
        assert_eq!(
            parse_probe("os=Linux\nhome=/home/u\ngit=\ntmux=\n")
                .unwrap_err()
                .kind,
            "no_git"
        );
    }

    #[test]
    fn classifies_ssh_failures() {
        assert_eq!(
            classify("Host key verification failed.\r\n").kind,
            "host_key"
        );
        assert_eq!(
            classify("me@h: Permission denied (publickey).").kind,
            "auth"
        );
        assert_eq!(
            classify("ssh: connect to host h port 22: Connection timed out").kind,
            "unreachable"
        );
        assert_eq!(
            classify("ssh: Could not resolve hostname nope: Name or service not known").kind,
            "unreachable"
        );
        let e = classify("warning\nsomething odd\n");
        assert_eq!(e.kind, "failed");
        assert_eq!(e.message, "something odd");
    }

    fn app(alias: &str) -> AppHost {
        AppHost {
            alias: alias.into(),
            host_name: "10.0.0.5".into(),
            user: "dev".into(),
            port: 2222,
            identity_file: None,
        }
    }

    #[test]
    fn app_host_is_validated_and_trimmed() {
        let ok = check_app_host(
            &AppHost {
                alias: " build-1 ".into(),
                host_name: " example.com ".into(),
                ..app("x")
            },
            &[],
        )
        .unwrap();
        assert_eq!(ok.alias, "build-1");
        assert_eq!(ok.host_name, "example.com");
        for bad in ["", "-oProxyCommand=x", "a b", "a|b", "a;b", "한글"] {
            assert!(check_app_host(&app(bad), &[]).is_err(), "alias {bad}");
        }
        assert!(check_app_host(&app("dup"), &["dup".to_string()]).is_err());
        for bad in ["", "-h", "a b", "h;rm", "$(x)"] {
            let h = AppHost {
                host_name: bad.into(),
                ..app("a")
            };
            assert!(check_app_host(&h, &[]).is_err(), "host {bad}");
            let u = AppHost {
                user: bad.into(),
                ..app("a")
            };
            assert!(check_app_host(&u, &[]).is_err(), "user {bad}");
        }
        assert!(check_app_host(
            &AppHost {
                port: 0,
                ..app("a")
            },
            &[]
        )
        .is_err());
        let ipv6 = AppHost {
            host_name: "fe80::1".into(),
            ..app("a")
        };
        assert!(check_app_host(&ipv6, &[]).is_ok());
        let missing_key = AppHost {
            identity_file: Some("/nonexistent/minmo/key".into()),
            ..app("a")
        };
        assert!(check_app_host(&missing_key, &[]).is_err());
    }

    #[test]
    fn app_hosts_roundtrip_and_merge_without_overriding_config() {
        let dir = tmp("apphosts");
        let path = dir.join("ssh-hosts.json");
        assert!(load_app_hosts(&path).is_empty());
        store_app_hosts(&path, &[app("one"), app("work")]).unwrap();
        let loaded = load_app_hosts(&path);
        assert_eq!(loaded, vec![app("one"), app("work")]);
        std::fs::write(dir.join("config"), "Host work\n  HostName cfg\n").unwrap();
        let merged = merge_hosts(parse_hosts(&dir.join("config"), None), loaded);
        let view: Vec<(&str, &str)> = merged
            .iter()
            .map(|h| (h.alias.as_str(), h.source))
            .collect();
        assert_eq!(view, [("work", "config"), ("one", "app")]);
        assert_eq!(merged[1].port, Some(2222));
        std::fs::write(&path, "broken").unwrap();
        assert!(load_app_hosts(&path).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn app_host_connects_with_explicit_options() {
        let h = app("one");
        let args = ssh_args_for("one", Some(&h), true, false);
        let joined = args.join(" ");
        assert!(joined.contains("-o HostName=10.0.0.5 -o User=dev -o Port=2222"));
        assert!(!joined.contains("IdentityFile"));
        assert!(!joined.contains("accept-new"));
        assert_eq!(
            args[args.len() - 2..],
            ["--".to_string(), "one".to_string()]
        );
        assert_eq!(
            identity_option(r"C:\Users\Kang Min\.ssh\id 100%"),
            r#"IdentityFile="C:\Users\Kang Min\.ssh\id 100%%""#
        );
        let quoted = AppHost {
            identity_file: Some("a\"b".into()),
            ..app("q")
        };
        assert!(check_app_host(&quoted, &[]).is_err());
        let trusting = ssh_args_for("one", Some(&h), true, true).join(" ");
        assert!(trusting.contains("StrictHostKeyChecking=accept-new"));
    }

    #[test]
    fn ssh_args_differ_for_batch_and_terminal() {
        let batch = ssh_args("h", true);
        assert!(batch.contains(&"BatchMode=yes".to_string()));
        assert_eq!(
            batch[batch.len() - 2..],
            ["--".to_string(), "h".to_string()]
        );
        let term = ssh_args("h", false);
        assert!(term.contains(&"-t".to_string()));
        assert!(!term.contains(&"BatchMode=yes".to_string()));
    }

    #[test]
    fn script_and_cancel_commands_use_a_sanitized_pid_file() {
        let cmd = script_command("run-1;x", "/w/t", &HashMap::new()).unwrap();
        assert!(cmd.starts_with("mkdir -p \"$HOME\"/.minmo/run && cd -- '/w/t' && exec 'sh' '-c' "));
        // 스크립트는 파일로 받아 stdin 을 끊고 실행한다
        assert!(cmd.contains(r#"cat > "$1.sh"; sh -e "$1.sh" < /dev/null"#));
        assert!(cmd.ends_with("\"$HOME\"/.minmo/run/run-1x.pid"));
        let cancel = cancel_command("run-1;x");
        assert!(cancel.contains("run-1x.pid"));
        assert!(cancel.contains("kill -TERM -\"$p\" "));
        assert!(!cancel.contains("-- -"));
    }
}
