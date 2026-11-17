// AI 별 사용량 — 각 도구가 이 컴퓨터에 남기는 기록에서 읽는다(읽기만 한다. 계정 API 는 부르지 않는다).
//   Claude Code: <설정 폴더>/projects/<폴더>/<세션>.jsonl, <세션>/subagents/*.jsonl 의 message.usage      … 토큰 수
//   Codex:       <CODEX_HOME>/sessions/<년>/<월>/<일>/rollout-*.jsonl 의 token_count(info·rate_limits) … 토큰 수·한도 사용률
//   Gemini CLI:  ~/.gemini/tmp/<프로젝트>/chats/session-*.json 의 messages[].tokens                   … 토큰 수
// 공개된 규격이 아니라 도구 버전에 따라 달라질 수 있다 — 읽지 못한 것은 건너뛴다(오류로 만들지 않는다).
// 원격 호스트는 같은 계산을 python3 으로 한다(desktop/src/features/usage/remoteUsage.ts) — 규칙을 바꾸면 함께 바꾸고,
// 두 구현은 같은 fixture(tests/fixtures/usage)로 맞춘다.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

/// Codex 의 한도 기록을 찾을 때 거슬러 올라가는 기간 — 가장 긴 한도 창(주간)보다 조금 길게
const LIMIT_LOOKBACK_MS: u64 = 8 * 24 * 60 * 60 * 1000;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    /// 새로 읽은 입력(캐시에서 읽은 것은 뺀다)
    pub input: u64,
    /// 출력(생각·도구 호출 포함)
    pub output: u64,
    /// 캐시에 새로 쓴 입력(Claude Code 만)
    pub cache_write: u64,
    /// 캐시에서 다시 읽은 입력 — 요청마다 대화 전체가 다시 세어지므로 합계에는 넣지 않고 따로 보인다
    pub cache_read: u64,
}

impl Tokens {
    fn add(&mut self, o: Tokens) {
        self.input += o.input;
        self.output += o.output;
        self.cache_write += o.cache_write;
        self.cache_read += o.cache_read;
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub used_percent: f64,
    /// 한도 창의 길이(분) — 300 = 5시간, 10080 = 1주
    pub window_minutes: u64,
    /// 한도가 초기화되는 시각(ms). 모르면 0
    pub resets_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    pub tokens: Tokens,
    /// 가장 최근 기록의 한도 사용률(없으면 빈 목록) — Codex 를 마지막으로 쓴 시점의 값이다
    pub limits: Vec<Limit>,
    /// limits 를 기록한 시각(ms). 없으면 0
    pub limits_at_ms: u64,
}

/// 도구의 기록 폴더가 없으면(쓰지 않는 도구) None
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub claude: Option<Tokens>,
    pub codex: Option<CodexUsage>,
    pub gemini: Option<Tokens>,
}

/// 파일이 바뀌었는지 보는 값 — 같으면 다시 읽지 않는다(세션 기록은 수십 MB 가 될 수 있다)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    size: u64,
    mtime_ms: u64,
    since_ms: u64,
}

#[derive(Debug, Clone, Default)]
struct CodexFile {
    tokens: Tokens,
    /// 이 파일의 마지막 한도 기록(시각, 한도들)
    limits: Option<(u64, Vec<Limit>)>,
}

/// 파일별 읽은 결과. 폴더에서 사라진 파일의 항목은 다음 조회 때 지운다
#[derive(Default)]
pub(crate) struct UsageCache {
    /// (중복 제거 키, 토큰) — 같은 응답이 여러 줄·여러 파일(이어 연 세션)에 기록된다
    claude: HashMap<PathBuf, (Stamp, Vec<(String, Tokens)>)>,
    codex: HashMap<PathBuf, (Stamp, CodexFile)>,
    gemini: HashMap<PathBuf, (Stamp, Tokens)>,
    /// 파일을 실제로 읽은 횟수(테스트용)
    #[cfg(test)]
    parses: usize,
}

static CACHE: Mutex<Option<UsageCache>> = Mutex::new(None);

fn stamp(path: &Path, since_ms: u64) -> Option<Stamp> {
    let m = fs::metadata(path).ok()?;
    let mtime_ms = m
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some(Stamp {
        size: m.len(),
        mtime_ms,
        since_ms,
    })
}

/// `YYYY-MM-DDTHH:MM:SS(.fff)(Z)` (UTC) → ms. 다른 모양이면 None
pub(crate) fn iso_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let frac = match s[19..].strip_prefix('.') {
        Some(rest) => {
            let digits: String = rest
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .take(3)
                .collect();
            format!("{digits:0<3}").parse::<i64>().ok()?
        }
        None => 0,
    };
    // 그레고리력 날짜 → 1970-01-01 부터의 날 수
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let ms = ((days * 24 + h) * 60 + mi) * 60_000 + sec * 1000 + frac;
    u64::try_from(ms).ok()
}

fn num(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn ts_ms(v: &Value) -> Option<u64> {
    iso_ms(v.get("timestamp")?.as_str()?)
}

/// dir 바로 아래의 항목들(읽지 못하면 빈 목록)
fn children(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|it| it.flatten().map(|e| e.path()).collect())
        .unwrap_or_default()
}

fn has_ext(p: &Path, ext: &str) -> bool {
    p.is_file() && p.extension().is_some_and(|e| e == ext)
}

/// 파일을 줄 단위로 읽어 key 글자가 든 줄만 JSON 으로 넘긴다(대부분의 줄은 사용량과 무관하다)
fn each_json_line(path: &Path, key: &str, mut f: impl FnMut(Value)) {
    let Ok(file) = fs::File::open(path) else {
        return;
    };
    for line in BufReader::new(file).lines() {
        // 쓰는 도중의 마지막 줄·깨진 글자는 건너뛴다
        let Ok(line) = line else { continue };
        if !line.contains(key) {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            f(v);
        }
    }
}

// ── Claude Code ──────────────────────────────────────────────────

fn claude_file(path: &Path, since_ms: u64) -> Vec<(String, Tokens)> {
    let mut out = Vec::new();
    let name = path.to_string_lossy().into_owned();
    let mut n = 0usize;
    each_json_line(path, "\"usage\"", |v| {
        n += 1;
        let Some(usage) = v.pointer("/message/usage") else {
            return;
        };
        if !ts_ms(&v).is_some_and(|t| t >= since_ms) {
            return;
        }
        let id = v.pointer("/message/id").and_then(Value::as_str);
        let req = v.get("requestId").and_then(Value::as_str);
        // 같은 응답은 한 번만 센다. id 가 없는 줄은 서로 다른 것으로 본다
        let key = match (id, req) {
            (Some(i), Some(r)) => format!("{i}:{r}"),
            (Some(i), None) => i.to_string(),
            _ => format!("{name}#{n}"),
        };
        out.push((
            key,
            Tokens {
                input: num(usage, "input_tokens"),
                output: num(usage, "output_tokens"),
                cache_write: num(usage, "cache_creation_input_tokens"),
                cache_read: num(usage, "cache_read_input_tokens"),
            },
        ));
    });
    out
}

/// projects 폴더의 세션 기록(하위 에이전트 포함)에서 since_ms 이후의 토큰 수
pub(crate) fn claude_usage(
    projects: &Path,
    since_ms: u64,
    cache: &mut UsageCache,
) -> Option<Tokens> {
    if !projects.is_dir() {
        return None;
    }
    let mut files = Vec::new();
    for project in children(projects) {
        for entry in children(&project) {
            if has_ext(&entry, "jsonl") {
                files.push(entry);
            } else if entry.is_dir() {
                files.extend(
                    children(&entry.join("subagents"))
                        .into_iter()
                        .filter(|p| has_ext(p, "jsonl")),
                );
            }
        }
    }
    let mut seen = HashSet::new();
    let mut total = Tokens::default();
    let mut live = HashSet::new();
    for path in files {
        // 오늘 바뀌지 않은 파일에는 오늘의 기록이 없다
        let Some(st) = stamp(&path, since_ms).filter(|s| s.mtime_ms >= since_ms) else {
            continue;
        };
        if cache.claude.get(&path).map(|c| c.0) != Some(st) {
            #[cfg(test)]
            {
                cache.parses += 1;
            }
            cache
                .claude
                .insert(path.clone(), (st, claude_file(&path, since_ms)));
        }
        for (key, t) in &cache.claude[&path].1 {
            if seen.insert(key.clone()) {
                total.add(*t);
            }
        }
        live.insert(path);
    }
    cache.claude.retain(|p, _| live.contains(p));
    Some(total)
}

// ── Codex ────────────────────────────────────────────────────────

fn codex_limits(rate: &Value, at_ms: u64) -> Vec<Limit> {
    ["primary", "secondary"]
        .iter()
        .filter_map(|k| rate.get(k).filter(|v| v.is_object()))
        .filter_map(|l| {
            let window_minutes = num(l, "window_minutes");
            // 버전에 따라 초기화 시각(초) 또는 남은 시간(초)으로 적는다
            let resets_at_ms = match (
                l.get("resets_at").and_then(Value::as_u64),
                l.get("resets_in_seconds").and_then(Value::as_u64),
            ) {
                (Some(at), _) => at * 1000,
                (None, Some(rem)) => at_ms + rem * 1000,
                _ => 0,
            };
            Some(Limit {
                used_percent: l.get("used_percent")?.as_f64()?,
                window_minutes,
                resets_at_ms,
            })
        })
        .collect()
}

fn codex_file(path: &Path, since_ms: u64) -> CodexFile {
    let mut out = CodexFile::default();
    // 세션의 누적값 — 같은 턴의 사용량이 여러 번 기록되므로 누적값의 증가분만 센다
    let mut prev: Option<(u64, u64, u64)> = None;
    each_json_line(path, "\"token_count\"", |v| {
        let Some(p) = v
            .get("payload")
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("token_count"))
        else {
            return;
        };
        let Some(at) = ts_ms(&v) else { return };
        if let Some(total) = p
            .pointer("/info/total_token_usage")
            .filter(|t| t.is_object())
        {
            let now = (
                num(total, "input_tokens"),
                num(total, "cached_input_tokens"),
                num(total, "output_tokens"),
            );
            // 누적값이 줄었으면(기록이 새로 시작됨) 그 값 전체가 증가분이다
            let base = prev
                .filter(|b| now.0 >= b.0 && now.1 >= b.1 && now.2 >= b.2)
                .unwrap_or((0, 0, 0));
            prev = Some(now);
            if at >= since_ms {
                let (input, cached, output) = (now.0 - base.0, now.1 - base.1, now.2 - base.2);
                // Codex 의 input_tokens 는 캐시에서 읽은 것을 포함한다
                out.tokens.add(Tokens {
                    input: input.saturating_sub(cached),
                    output,
                    cache_write: 0,
                    cache_read: cached,
                });
            }
        }
        if let Some(rate) = p.get("rate_limits").filter(|r| r.is_object()) {
            let limits = codex_limits(rate, at);
            if !limits.is_empty() {
                out.limits = Some((at, limits));
            }
        }
    });
    out
}

/// sessions 폴더(<년>/<월>/<일>/rollout-*.jsonl)에서 since_ms 이후의 토큰 수와 가장 최근의 한도 사용률
pub(crate) fn codex_usage(
    sessions: &Path,
    since_ms: u64,
    now_ms: u64,
    cache: &mut UsageCache,
) -> Option<CodexUsage> {
    if !sessions.is_dir() {
        return None;
    }
    let mut files: Vec<(PathBuf, Stamp)> = Vec::new();
    for year in children(sessions) {
        for month in children(&year) {
            for day in children(&month) {
                for f in children(&day).into_iter().filter(|p| has_ext(p, "jsonl")) {
                    if let Some(st) = stamp(&f, since_ms) {
                        files.push((f, st));
                    }
                }
            }
        }
    }
    // 한도는 가장 최근 기록의 것 — 오늘 쓰지 않았어도 지난 기록에서 찾는다
    let oldest = since_ms.min(now_ms.saturating_sub(LIMIT_LOOKBACK_MS));
    files.retain(|(_, st)| st.mtime_ms >= oldest);
    files.sort_by_key(|f| std::cmp::Reverse(f.1.mtime_ms));
    let mut tokens = Tokens::default();
    let mut latest: Option<(u64, Vec<Limit>)> = None;
    let mut live = HashSet::new();
    for (path, st) in files {
        // 오늘 바뀌지 않은 파일은 한도를 아직 찾지 못했을 때만 읽는다
        if st.mtime_ms < since_ms && latest.is_some() {
            continue;
        }
        if cache.codex.get(&path).map(|c| c.0) != Some(st) {
            #[cfg(test)]
            {
                cache.parses += 1;
            }
            cache
                .codex
                .insert(path.clone(), (st, codex_file(&path, since_ms)));
        }
        let file = &cache.codex[&path].1;
        tokens.add(file.tokens);
        if let Some((at, limits)) = &file.limits {
            if latest.as_ref().map_or(true, |l| *at > l.0) {
                latest = Some((*at, limits.clone()));
            }
        }
        live.insert(path);
    }
    cache.codex.retain(|p, _| live.contains(p));
    let (limits_at_ms, limits) = latest.unwrap_or((0, Vec::new()));
    Some(CodexUsage {
        tokens,
        limits,
        limits_at_ms,
    })
}

// ── Gemini CLI ───────────────────────────────────────────────────

fn gemini_file(path: &Path, since_ms: u64) -> Tokens {
    let mut out = Tokens::default();
    let Some(v) = fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    else {
        return out;
    };
    for m in v
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(t) = m.get("tokens").filter(|t| t.is_object()) else {
            continue;
        };
        if !ts_ms(m).is_some_and(|at| at >= since_ms) {
            continue;
        }
        let cached = num(t, "cached");
        out.add(Tokens {
            // Gemini 의 input 은 캐시에서 읽은 것을 포함한다
            input: num(t, "input").saturating_sub(cached),
            output: num(t, "output") + num(t, "thoughts") + num(t, "tool"),
            cache_write: 0,
            cache_read: cached,
        });
    }
    out
}

/// tmp 폴더(<프로젝트>/chats/session-*.json)에서 since_ms 이후의 토큰 수
pub(crate) fn gemini_usage(tmp: &Path, since_ms: u64, cache: &mut UsageCache) -> Option<Tokens> {
    if !tmp.is_dir() {
        return None;
    }
    let mut total = Tokens::default();
    let mut live = HashSet::new();
    for project in children(tmp) {
        for path in children(&project.join("chats"))
            .into_iter()
            .filter(|p| has_ext(p, "json"))
        {
            let Some(st) = stamp(&path, since_ms).filter(|s| s.mtime_ms >= since_ms) else {
                continue;
            };
            if cache.gemini.get(&path).map(|c| c.0) != Some(st) {
                #[cfg(test)]
                {
                    cache.parses += 1;
                }
                cache
                    .gemini
                    .insert(path.clone(), (st, gemini_file(&path, since_ms)));
            }
            total.add(cache.gemini[&path].1);
            live.insert(path);
        }
    }
    cache.gemini.retain(|p, _| live.contains(p));
    Some(total)
}

// ── 명령 ─────────────────────────────────────────────────────────

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// 환경 변수(name)가 있으면 그 폴더, 없으면 홈의 fallback
fn tool_dir(name: &str, fallback: &str) -> Option<PathBuf> {
    match std::env::var_os(name) {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => Some(home_dir()?.join(fallback)),
    }
}

pub(crate) fn usage_at(
    claude: Option<&Path>,
    codex: Option<&Path>,
    gemini: Option<&Path>,
    since_ms: u64,
    now_ms: u64,
    cache: &mut UsageCache,
) -> AgentUsage {
    AgentUsage {
        claude: claude.and_then(|d| claude_usage(d, since_ms, cache)),
        codex: codex.and_then(|d| codex_usage(d, since_ms, now_ms, cache)),
        gemini: gemini.and_then(|d| gemini_usage(d, since_ms, cache)),
    }
}

/// 이 컴퓨터의 AI 별 사용량: since_ms(화면의 오늘 자정) 이후의 토큰 수와 Codex 의 한도 사용률
#[tauri::command]
pub async fn agent_usage(since_ms: u64) -> Result<AgentUsage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let claude = tool_dir("CLAUDE_CONFIG_DIR", ".claude").map(|d| d.join("projects"));
        let codex = tool_dir("CODEX_HOME", ".codex").map(|d| d.join("sessions"));
        let gemini = home_dir().map(|d| d.join(".gemini").join("tmp"));
        let now_ms = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut guard = CACHE.lock().map_err(|e| e.to_string())?;
        let cache = guard.get_or_insert_with(UsageCache::default);
        Ok(usage_at(
            claude.as_deref(),
            codex.as_deref(),
            gemini.as_deref(),
            since_ms,
            now_ms,
            cache,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 원격 스크립트(python3)와 함께 쓰는 fixture — 가짜 홈 폴더
    fn fixture_home() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("usage")
            .join("home")
    }

    /// fixture 의 "오늘" 자정(UTC)과 지금
    const SINCE: &str = "2026-11-17T00:00:00Z";
    const NOW: &str = "2026-11-17T12:00:00Z";

    fn fixture_usage(cache: &mut UsageCache) -> AgentUsage {
        let home = fixture_home();
        usage_at(
            Some(&home.join(".claude").join("projects")),
            Some(&home.join(".codex").join("sessions")),
            Some(&home.join(".gemini").join("tmp")),
            iso_ms(SINCE).unwrap(),
            iso_ms(NOW).unwrap(),
            cache,
        )
    }

    /// 이 PC 의 실제 기록으로 값을 본다(수동 확인용): cargo test --lib usage::tests::prints_real_usage -- --ignored --nocapture
    #[test]
    #[ignore]
    fn prints_real_usage() {
        let claude = tool_dir("CLAUDE_CONFIG_DIR", ".claude").map(|d| d.join("projects"));
        let codex = tool_dir("CODEX_HOME", ".codex").map(|d| d.join("sessions"));
        let gemini = home_dir().map(|d| d.join(".gemini").join("tmp"));
        let now_ms = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        // UTC 자정부터(화면은 그 기기의 자정을 넘긴다)
        let since_ms = now_ms - now_ms % 86_400_000;
        let mut cache = UsageCache::default();
        let started = std::time::Instant::now();
        let usage = usage_at(
            claude.as_deref(),
            codex.as_deref(),
            gemini.as_deref(),
            since_ms,
            now_ms,
            &mut cache,
        );
        let first = started.elapsed();
        let started = std::time::Instant::now();
        usage_at(
            claude.as_deref(),
            codex.as_deref(),
            gemini.as_deref(),
            since_ms,
            now_ms,
            &mut cache,
        );
        println!("{}", serde_json::to_string_pretty(&usage).unwrap());
        println!(
            "files read: {} · first {first:?} · again {:?}",
            cache.parses,
            started.elapsed()
        );
    }

    #[test]
    fn iso_ms_reads_utc_timestamps() {
        assert_eq!(iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_ms("2026-11-17T01:48:33.793Z"), Some(1_794_880_113_793));
        assert_eq!(iso_ms("2026-11-17T01:48:33Z"), Some(1_794_880_113_000));
        // 소수 자릿수가 달라도 ms 로 맞춘다
        assert_eq!(iso_ms("2026-11-17T01:48:33.7Z"), Some(1_794_880_113_700));
        assert_eq!(
            iso_ms("2026-11-17T01:48:33.793123Z"),
            Some(1_794_880_113_793)
        );
        assert_eq!(iso_ms("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
        for bad in [
            "",
            "2026-11-17",
            "2026/11/17T01:48:33Z",
            "not a time at all!!",
        ] {
            assert_eq!(iso_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn fixture_matches_expected_json() {
        // expected.json 은 원격 스크립트의 테스트도 함께 쓴다 — 두 구현의 결과가 같아야 한다
        let expected: Value = serde_json::from_slice(
            &fs::read(fixture_home().parent().unwrap().join("expected.json")).unwrap(),
        )
        .unwrap();
        let got = serde_json::to_value(fixture_usage(&mut UsageCache::default())).unwrap();
        assert_eq!(got, expected);
    }

    #[test]
    fn unchanged_files_are_not_read_again() {
        let mut cache = UsageCache::default();
        let first = fixture_usage(&mut cache);
        let parsed = cache.parses;
        assert!(parsed > 0);
        assert_eq!(fixture_usage(&mut cache), first);
        assert_eq!(cache.parses, parsed, "바뀌지 않은 파일을 다시 읽었다");
        // 날이 바뀌면(since 가 달라지면) 다시 읽는다
        let home = fixture_home();
        claude_usage(
            &home.join(".claude").join("projects"),
            iso_ms(SINCE).unwrap() + 1,
            &mut cache,
        );
        assert!(cache.parses > parsed);
    }

    #[test]
    fn missing_folders_mean_the_tool_is_not_used() {
        let none = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("no-such-folder");
        let mut cache = UsageCache::default();
        let u = usage_at(Some(&none), Some(&none), Some(&none), 0, 0, &mut cache);
        assert_eq!((u.claude, u.codex, u.gemini), (None, None, None));
        assert_eq!(
            serde_json::to_value(usage_at(None, None, None, 0, 0, &mut cache)).unwrap(),
            serde_json::json!({ "claude": null, "codex": null, "gemini": null })
        );
    }

    #[test]
    fn files_not_touched_today_are_skipped_and_dropped_from_the_cache() {
        let dir = std::env::temp_dir().join(format!("minmo-usage-test-{}", std::process::id()));
        let project = dir.join("p");
        fs::create_dir_all(&project).unwrap();
        let file = project.join("s.jsonl");
        fs::write(&file, "{\"timestamp\":\"2026-11-17T01:00:00Z\",\"requestId\":\"r\",\"message\":{\"id\":\"m\",\"usage\":{\"input_tokens\":5,\"output_tokens\":7}}}\n").unwrap();
        let mut cache = UsageCache::default();
        let since = iso_ms(SINCE).unwrap();
        assert_eq!(claude_usage(&dir, since, &mut cache).unwrap().output, 7);
        assert_eq!(cache.claude.len(), 1);
        // 파일의 수정 시각이 since 보다 앞이면 읽지 않고, 보관한 결과도 지운다
        let old = UNIX_EPOCH + std::time::Duration::from_millis(since - 1000);
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert_eq!(
            claude_usage(&dir, since, &mut cache),
            Some(Tokens::default())
        );
        assert!(cache.claude.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
