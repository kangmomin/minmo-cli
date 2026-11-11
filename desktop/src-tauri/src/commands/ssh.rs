// 원격 호스트(SSH 프로필) — 이 PC 의 ssh 로 ~/.ssh/config 의 Host 별칭에 접속해 명령을 실행한다.
// 원격에는 POSIX 셸과 git 만 있으면 된다(minmo CLI·역터널 불필요). 키·ProxyJump 등은 사용자의 ssh 설정을 그대로 따른다.
// 명령 실행은 BatchMode 라 프롬프트(비밀번호·호스트 키 확인)가 필요하면 멈추지 않고 실패한다.
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::Serialize;
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

fn parse_into(path: &Path, home: Option<&Path>, depth: usize, out: &mut Vec<SshHost>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let base = path.parent().unwrap_or(Path::new("."));
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
                    if alias.is_empty() || alias.contains(['*', '?', '!']) || alias.starts_with('-')
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
                        parse_into(&target, home, depth + 1, out);
                    }
                }
            }
            _ => {}
        }
    }
}

pub(crate) fn parse_hosts(path: &Path, home: Option<&Path>) -> Vec<SshHost> {
    let mut out = Vec::new();
    parse_into(path, home, 0, &mut out);
    out
}

fn list_hosts() -> Vec<SshHost> {
    match config_path() {
        Some(p) => parse_hosts(&p, home_dir().as_deref()),
        None => vec![],
    }
}

/// 설정 파일에 있는 별칭만 허용한다 — 웹뷰가 넘긴 값이 ssh 옵션(-o ProxyCommand=…)으로 해석되지 않게
pub(crate) fn validate_host(host: &str) -> Result<(), String> {
    if list_hosts().iter().any(|h| h.alias == host) {
        Ok(())
    } else {
        Err(format!("~/.ssh/config 에 없는 호스트입니다: {host}"))
    }
}

/// ssh 인자(원격 명령 앞까지). batch=true 는 프롬프트 없이 실패하는 명령 실행용, false 는 터미널용
pub(crate) fn ssh_args(host: &str, batch: bool) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
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

async fn run_ssh(
    state: &SshState,
    host: &str,
    remote: String,
    stdin: Option<String>,
) -> Result<CmdResult, SshError> {
    validate_host(host).map_err(|m| SshError::new("unknown_host", m))?;
    let sem = state.sem(host);
    let _permit = sem
        .acquire()
        .await
        .map_err(|e| SshError::new("failed", e.to_string()))?;
    let mut cmd = tokio::process::Command::new(ssh_program());
    cmd.args(ssh_args(host, true))
        .arg(remote)
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

#[tauri::command]
pub async fn ssh_probe(state: State<'_, SshState>, host: String) -> Result<Probe, SshError> {
    let res = run_ssh(&state, &host, PROBE.to_string(), None).await?;
    parse_probe(&res.stdout)
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
    run_ssh(&state, &host, remote, stdin)
        .await
        .map_err(|e| format!("ssh({}): {}", e.kind, e.message))
}

fn pid_file(run_id: &str) -> String {
    format!("\"$HOME\"/.minmo/run/{}.pid", safe_name(run_id))
}

/// 원격 스크립트 실행 명령. sshd 는 명령을 새 세션(프로세스 그룹)의 리더로 띄우고 exec 로 pid 가 유지되므로,
/// 기록한 pid 가 곧 그룹 id 다 — 취소 때 그룹 전체에 신호를 보낸다
pub(crate) fn script_command(
    run_id: &str,
    cwd: &str,
    env: &HashMap<String, String>,
) -> Result<String, String> {
    let wrapper = r#"echo $$ > "$1"; sh -e -s; c=$?; rm -f "$1"; exit $c"#;
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
    format!(
        "p=$(cat {pid} 2>/dev/null) || exit 0; kill -TERM -- -\"$p\" 2>/dev/null || kill -TERM \"$p\" 2>/dev/null; sleep 3; kill -KILL -- -\"$p\" 2>/dev/null; rm -f {pid}"
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
        .arg(remote)
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
    let running = lock(&state.scripts).get(&run_id).cloned();
    if let Some((host, pid)) = running {
        // 로컬 ssh 를 끊어도 원격 프로세스는 남는다(tty 없음) — 원격 그룹을 먼저 끝낸다
        let _ = run_ssh(&state, &host, cancel_command(&run_id), None).await;
        tauri::async_runtime::spawn_blocking(move || super::script::kill_tree(pid))
            .await
            .map_err(|e| e.to_string())?;
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
        assert!(cmd.ends_with("\"$HOME\"/.minmo/run/run-1x.pid"));
        let cancel = cancel_command("run-1;x");
        assert!(cancel.contains("run-1x.pid"));
        assert!(cancel.contains("kill -TERM -- -\"$p\""));
    }
}
