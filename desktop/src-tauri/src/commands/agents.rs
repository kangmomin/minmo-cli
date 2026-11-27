// Claude Code 의 하위 에이전트 현황 — Claude Code 가 작업 폴더별로 남기는 세션 기록에서 하위 에이전트의 메타 파일을 읽는다.
//   <설정 폴더>/projects/<작업 폴더 이름>/<세션 id>.jsonl                     … 세션 기록
//   <설정 폴더>/projects/<작업 폴더 이름>/<세션 id>/subagents/agent-<id>.meta.json  … 하위 에이전트(종류·설명·끝났는지)
// 공개된 규격이 아니라 Claude Code 버전에 따라 달라질 수 있다 — 읽지 못하면 빈 목록을 돌려준다(상태 표시는 그대로 동작한다).
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// 한 번에 돌려줄 하위 에이전트 수(최근 것부터)
const MAX_SUBAGENTS: usize = 100;
/// 메타 파일 하나의 크기 상한 — 넘으면 건너뛴다
const MAX_META_BYTES: u64 = 64 * 1024;
/// 마지막 답변을 찾을 때 읽는 세션 기록 끝부분의 크기
const REPLY_TAIL_BYTES: u64 = 256 * 1024;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubagentFile {
    /// 파일 이름의 agent-<id>
    pub id: String,
    /// meta.json 원문(해석은 화면 쪽에서 — 원격 호스트와 같은 코드로)
    pub meta: String,
    /// 그 하위 에이전트의 기록이 마지막으로 바뀐 시각(ms)
    pub updated_ms: u64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeReplyTail {
    pub tail: String,
    pub updated_ms: u64,
}

/// Claude Code 가 작업 폴더 경로로 폴더 이름을 만드는 방식: 영문·숫자가 아닌 글자를 모두 `-` 로 바꾼다
pub(crate) fn project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// cwd 의 세션 기록 폴더. 정확히 그 이름의 폴더가 먼저고, 없을 때만 이름을 같은 규칙으로 바꿔 찾는다
/// (버전에 따라 `_`·`.` 를 남기는 경우, Windows 드라이브 문자의 대소문자 차이)
fn project_dir(projects: &Path, cwd: &str) -> Option<PathBuf> {
    let slug = project_slug(cwd.trim_end_matches(['/', '\\']));
    let exact = projects.join(&slug);
    if exact.is_dir() {
        return Some(exact);
    }
    fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.is_dir()
                && p.file_name()
                    .is_some_and(|n| project_slug(&n.to_string_lossy()).eq_ignore_ascii_case(&slug))
        })
}

/// projects 폴더에서 cwd 의 세션 기록 중 가장 최근에 바뀐 것 = 지금 쓰는(또는 마지막으로 쓴) 세션.
/// since_ms 이전에 마지막으로 바뀐 세션은 보지 않는다(이전 실행의 기록을 지금 것으로 보이지 않게)
fn current_session(projects: &Path, cwd: &str, since_ms: u64) -> Option<PathBuf> {
    let project = project_dir(projects, cwd)?;
    let newest: Option<(SystemTime, PathBuf)> = fs::read_dir(&project)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| Some((fs::metadata(&p).ok()?.modified().ok()?, p)))
        .max_by_key(|(t, _)| *t);
    let (_, session) = newest?;
    (mtime_ms(&session) >= since_ms).then_some(session)
}

/// projects 폴더에서 cwd 의 세션 중 가장 최근 것의 하위 에이전트 메타 파일들(최근 것부터).
/// since_ms 이전에 마지막으로 바뀐 세션은 보지 않는다(이전 실행의 기록을 지금 것으로 보이지 않게)
pub(crate) fn subagent_files(projects: &Path, cwd: &str, since_ms: u64) -> Vec<SubagentFile> {
    let Some(session) = current_session(projects, cwd, since_ms) else {
        return Vec::new();
    };
    let dir = session.with_extension("").join("subagents");
    let mut out: Vec<SubagentFile> = fs::read_dir(&dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_string_lossy().into_owned();
            let id = name.strip_suffix(".meta.json")?.to_string();
            if !id.starts_with("agent-") || e.metadata().ok()?.len() > MAX_META_BYTES {
                return None;
            }
            let meta = fs::read_to_string(&path).ok()?;
            // 기록(jsonl)이 바뀐 시각이 활동 시각이다. 없으면 메타 파일의 시각
            let log = dir.join(format!("{id}.jsonl"));
            let updated_ms = mtime_ms(&log).max(mtime_ms(&path));
            Some(SubagentFile {
                id,
                meta,
                updated_ms,
            })
        })
        .collect();
    out.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms).then(a.id.cmp(&b.id)));
    out.truncate(MAX_SUBAGENTS);
    out
}

/// cwd 의 가장 최근 세션 기록의 끝부분(최대 256KiB)과 그 기록이 바뀐 시각(ms). 기록이 없으면 Ok(None), 열거나 읽지 못하면 Err.
/// 기록은 길어질 수 있어 끝만 읽는다 — 첫 줄은 중간에서 잘릴 수 있다(화면 쪽이 해석하지 못한 줄을 건너뛴다)
pub(crate) fn reply_tail(projects: &Path, cwd: &str) -> Result<Option<(String, u64)>, String> {
    let Some(session) = current_session(projects, cwd, 0) else {
        return Ok(None);
    };
    let fail = |e: std::io::Error| format!("세션 기록을 읽지 못했습니다: {e}");
    let mut file = File::open(&session).map_err(fail)?;
    let len = file.metadata().map_err(fail)?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(REPLY_TAIL_BYTES)))
        .map_err(fail)?;
    let mut buf = Vec::new();
    file.take(REPLY_TAIL_BYTES)
        .read_to_end(&mut buf)
        .map_err(fail)?;
    Ok(Some((
        String::from_utf8_lossy(&buf).into_owned(),
        mtime_ms(&session),
    )))
}

/// Claude Code 설정 폴더 — CLAUDE_CONFIG_DIR 이 있으면 그것, 없으면 ~/.claude (앱에서 띄운 터미널은 앱의 환경을 물려받는다)
fn claude_projects_dir() -> Option<PathBuf> {
    let base = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var_os(if cfg!(windows) {
            "USERPROFILE"
        } else {
            "HOME"
        })?)
        .join(".claude"),
    };
    Some(base.join("projects"))
}

/// cwd(작업 폴더)에서 도는 Claude Code 의 가장 최근 세션의 하위 에이전트들.
/// 기록이 없거나 그 세션이 since_ms 전에 마지막으로 바뀌었으면 빈 목록
#[tauri::command]
pub async fn claude_subagents(cwd: String, since_ms: u64) -> Result<Vec<SubagentFile>, String> {
    let Some(projects) = claude_projects_dir() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || subagent_files(&projects, &cwd, since_ms))
        .await
        .map_err(|e| e.to_string())
}

/// cwd(작업 폴더)에서 도는 Claude Code 의 가장 최근 세션 기록 끝부분(마지막 답변 찾기용 — 해석은 화면 쪽에서).
/// 기록 시각을 함께 보이므로 since 로 거르지 않는다. 기록이 없으면 None, 기록을 읽지 못하면 Err
#[tauri::command]
pub async fn claude_last_reply(cwd: String) -> Result<Option<ClaudeReplyTail>, String> {
    let Some(projects) = claude_projects_dir() else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        reply_tail(&projects, &cwd)
            .map(|r| r.map(|(tail, updated_ms)| ClaudeReplyTail { tail, updated_ms }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("minmo-agents-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn project_slug_replaces_everything_but_ascii_alphanumerics() {
        assert_eq!(
            project_slug(r"C:\workspace\minmo-cli"),
            "C--workspace-minmo-cli"
        );
        assert_eq!(
            project_slug("/home/u/minmo-workspaces/_local/app/issue--1-a b"),
            "-home-u-minmo-workspaces--local-app-issue--1-a-b"
        );
        assert_eq!(project_slug("/한글/x.y"), "----x-y");
    }

    /// 파일을 쓰고 바뀐 시각을 직접 정한다(파일 시스템의 시각 해상도에 기대지 않게)
    fn write_at(path: &Path, body: &str, secs: u64) {
        fs::write(path, body).unwrap();
        let t = UNIX_EPOCH + std::time::Duration::from_secs(secs);
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(t)
            .unwrap();
    }

    #[test]
    fn reads_metas_of_the_newest_session_newest_first() {
        let projects = tmp("read");
        // 폴더 이름에 `_` 가 남아 있어도 같은 규칙으로 바꿔 찾는다
        let project = projects.join("-w-_local-app");
        let old = project.join("old-session").join("subagents");
        let cur = project.join("cur-session").join("subagents");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&cur).unwrap();
        write_at(&project.join("old-session.jsonl"), "{}", 1_000);
        write_at(
            &old.join("agent-old.meta.json"),
            r#"{"finished":true}"#,
            1_000,
        );
        write_at(&project.join("cur-session.jsonl"), "{}", 5_000);
        write_at(
            &cur.join("agent-a1.meta.json"),
            r#"{"agentType":"Explore","description":"찾기","finished":true}"#,
            2_000,
        );
        write_at(&cur.join("agent-a1.jsonl"), "{}", 2_500);
        write_at(
            &cur.join("agent-b2.meta.json"),
            r#"{"agentType":"general-purpose","description":"리뷰"}"#,
            3_000,
        );
        write_at(&cur.join("agent-b2.jsonl"), "{}", 4_000);
        // 메타가 아닌 파일·너무 큰 메타는 건너뛴다
        fs::write(cur.join("notes.txt"), "x").unwrap();
        fs::write(cur.join("agent-big.meta.json"), "x".repeat(70 * 1024)).unwrap();

        let got = subagent_files(&projects, "/w/_local/app/", 0);
        assert_eq!(
            got.iter()
                .map(|s| (s.id.as_str(), s.updated_ms))
                .collect::<Vec<_>>(),
            // 활동 시각 = 기록(jsonl)이 바뀐 시각
            [("agent-b2", 4_000_000), ("agent-a1", 2_500_000)]
        );
        assert!(got[0].meta.contains("general-purpose"));

        // 에이전트가 뜨기 전에 끝난 세션의 기록은 보지 않는다
        assert_eq!(
            subagent_files(&projects, "/w/_local/app", 5_000_000).len(),
            2
        );
        assert!(subagent_files(&projects, "/w/_local/app", 5_000_001).is_empty());
        let _ = fs::remove_dir_all(&projects);
    }

    #[test]
    fn exact_project_folder_wins_and_the_fallback_ignores_case() {
        let projects = tmp("exact");
        // 서로 다른 폴더가 같은 slug 로 바뀌는 경우(_local 과 -local): 정확한 이름의 폴더를 읽는다
        for (name, id) in [
            ("-w-_local-app", "agent-under"),
            ("-w--local-app", "agent-exact"),
        ] {
            let dir = projects.join(name).join("s").join("subagents");
            fs::create_dir_all(&dir).unwrap();
            fs::write(projects.join(name).join("s.jsonl"), "{}").unwrap();
            fs::write(dir.join(format!("{id}.meta.json")), "{}").unwrap();
        }
        let got = subagent_files(&projects, "/w/_local/app", 0);
        assert_eq!(
            got.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["agent-exact"]
        );

        // 드라이브 문자의 대소문자가 달라도 찾는다
        let win = projects.join("C--work-app").join("s").join("subagents");
        fs::create_dir_all(&win).unwrap();
        fs::write(projects.join("C--work-app").join("s.jsonl"), "{}").unwrap();
        fs::write(win.join("agent-w.meta.json"), "{}").unwrap();
        assert_eq!(subagent_files(&projects, "c:/work/app", 0).len(), 1);
        let _ = fs::remove_dir_all(&projects);
    }

    #[test]
    fn missing_project_session_or_subagents_gives_an_empty_list() {
        let projects = tmp("empty");
        assert!(subagent_files(&projects, "/nope", 0).is_empty());
        let project = projects.join("-w-app");
        fs::create_dir_all(&project).unwrap();
        assert!(subagent_files(&projects, "/w/app", 0).is_empty());
        fs::write(project.join("s.jsonl"), "{}").unwrap();
        assert!(subagent_files(&projects, "/w/app", 0).is_empty());
        assert!(subagent_files(&projects.join("missing"), "/w/app", 0).is_empty());
        let _ = fs::remove_dir_all(&projects);
    }

    #[test]
    fn reply_tail_reads_only_the_end_of_a_long_session() {
        let projects = tmp("tail");
        let project = projects.join("-w-app");
        fs::create_dir_all(&project).unwrap();
        // 1MB 가 넘는 기록: 앞부분 표시는 읽지 않고, 끝의 마지막 답은 읽는다
        let last = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"END"}]}}"#;
        let body = format!("HEAD\n{}\n{last}\n", "x".repeat(1024 * 1024));
        write_at(&project.join("s.jsonl"), &body, 7_000);
        let (tail, updated_ms) = reply_tail(&projects, "/w/app").unwrap().unwrap();
        assert_eq!(tail.len() as u64, REPLY_TAIL_BYTES);
        assert!(tail.ends_with(&format!("{last}\n")));
        assert!(!tail.contains("HEAD"));
        assert_eq!(updated_ms, 7_000_000);
        let _ = fs::remove_dir_all(&projects);
    }

    #[test]
    fn reply_tail_reads_the_newest_session_whole_when_it_is_short() {
        let projects = tmp("newest");
        let project = projects.join("-w-app");
        fs::create_dir_all(&project).unwrap();
        write_at(&project.join("old.jsonl"), "old\n", 1_000);
        write_at(&project.join("cur.jsonl"), "cur\n", 3_000);
        // 하위 에이전트 폴더(<세션>/subagents)의 기록은 세션이 아니다
        fs::create_dir_all(project.join("cur").join("subagents")).unwrap();
        write_at(
            &project.join("cur").join("subagents").join("agent-a.jsonl"),
            "sub\n",
            9_000,
        );
        assert_eq!(
            reply_tail(&projects, "/w/app"),
            Ok(Some(("cur\n".to_string(), 3_000_000)))
        );
        let _ = fs::remove_dir_all(&projects);
    }

    #[test]
    fn reply_tail_is_none_without_a_session() {
        let projects = tmp("noreply");
        assert_eq!(reply_tail(&projects, "/w/app"), Ok(None));
        fs::create_dir_all(projects.join("-w-app")).unwrap();
        assert_eq!(reply_tail(&projects, "/w/app"), Ok(None));
        assert_eq!(reply_tail(&projects.join("missing"), "/w/app"), Ok(None));
        let _ = fs::remove_dir_all(&projects);
    }

    #[test]
    fn reply_tail_fails_when_the_newest_session_cannot_be_read() {
        let projects = tmp("unreadable");
        let project = projects.join("-w-app");
        fs::create_dir_all(&project).unwrap();
        write_at(&project.join("old.jsonl"), "old\n", 1_000);
        // Why: 가장 최근 "기록"이 파일이 아니다(폴더) — Windows 는 열기, Unix 는 읽기에서 실패한다
        fs::create_dir_all(project.join("x.jsonl")).unwrap();
        assert!(reply_tail(&projects, "/w/app").is_err());
        let _ = fs::remove_dir_all(&projects);
    }

    #[test]
    fn reply_tail_serializes_with_the_webview_field_names() {
        let tail = ClaudeReplyTail {
            tail: "x".into(),
            updated_ms: 5,
        };
        assert_eq!(
            serde_json::to_value(&tail).unwrap(),
            serde_json::json!({ "tail": "x", "updatedMs": 5 })
        );
    }
}
