// Claude Code 의 하위 에이전트 현황 — Claude Code 가 작업 폴더별로 남기는 세션 기록에서 하위 에이전트의 메타 파일을 읽는다.
//   <설정 폴더>/projects/<작업 폴더 이름>/<세션 id>.jsonl                     … 세션 기록
//   <설정 폴더>/projects/<작업 폴더 이름>/<세션 id>/subagents/agent-<id>.meta.json  … 하위 에이전트(종류·설명·끝났는지)
// 공개된 규격이 아니라 Claude Code 버전에 따라 달라질 수 있다 — 읽지 못하면 빈 목록을 돌려준다(상태 표시는 그대로 동작한다).
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// 한 번에 돌려줄 하위 에이전트 수(최근 것부터)
const MAX_SUBAGENTS: usize = 100;
/// 메타 파일 하나의 크기 상한 — 넘으면 건너뛴다
const MAX_META_BYTES: u64 = 64 * 1024;

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

/// projects 폴더에서 cwd 의 세션 중 가장 최근 것의 하위 에이전트 메타 파일들(최근 것부터)
pub(crate) fn subagent_files(projects: &Path, cwd: &str) -> Vec<SubagentFile> {
    let slug = project_slug(cwd.trim_end_matches(['/', '\\']));
    // 버전에 따라 `_`·`.` 를 남기는 경우가 있어, 폴더 이름도 같은 규칙으로 바꿔 비교한다
    let Some(project) = fs::read_dir(projects).ok().and_then(|entries| {
        entries.flatten().map(|e| e.path()).find(|p| {
            p.is_dir()
                && p.file_name()
                    .is_some_and(|n| project_slug(&n.to_string_lossy()) == slug)
        })
    }) else {
        return Vec::new();
    };
    // 가장 최근에 바뀐 세션 기록 = 지금 쓰는(또는 마지막으로 쓴) 세션
    let newest: Option<(SystemTime, PathBuf)> = fs::read_dir(&project)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| Some((fs::metadata(&p).ok()?.modified().ok()?, p)))
        .max_by_key(|(t, _)| *t);
    let Some((_, session)) = newest else {
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

/// cwd(작업 폴더)에서 도는 Claude Code 의 가장 최근 세션의 하위 에이전트들. 기록이 없으면 빈 목록
#[tauri::command]
pub async fn claude_subagents(cwd: String) -> Result<Vec<SubagentFile>, String> {
    let Some(projects) = claude_projects_dir() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || subagent_files(&projects, &cwd))
        .await
        .map_err(|e| e.to_string())
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

    #[test]
    fn reads_metas_of_the_newest_session_newest_first() {
        let projects = tmp("read");
        // 폴더 이름에 `_` 가 남아 있어도 같은 규칙으로 바꿔 찾는다
        let project = projects.join("-w-_local-app");
        let old = project.join("old-session").join("subagents");
        let cur = project.join("cur-session").join("subagents");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&cur).unwrap();
        fs::write(project.join("old-session.jsonl"), "{}").unwrap();
        fs::write(old.join("agent-old.meta.json"), r#"{"finished":true}"#).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(project.join("cur-session.jsonl"), "{}").unwrap();
        fs::write(
            cur.join("agent-a1.meta.json"),
            r#"{"agentType":"Explore","description":"찾기","finished":true}"#,
        )
        .unwrap();
        fs::write(cur.join("agent-a1.jsonl"), "{}").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        fs::write(
            cur.join("agent-b2.meta.json"),
            r#"{"agentType":"general-purpose","description":"리뷰","finished":false}"#,
        )
        .unwrap();
        fs::write(cur.join("agent-b2.jsonl"), "{}").unwrap();
        // 메타가 아닌 파일·너무 큰 메타는 건너뛴다
        fs::write(cur.join("notes.txt"), "x").unwrap();
        fs::write(cur.join("agent-big.meta.json"), "x".repeat(70 * 1024)).unwrap();

        let got = subagent_files(&projects, "/w/_local/app/");
        assert_eq!(
            got.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["agent-b2", "agent-a1"]
        );
        assert!(got[0].meta.contains("general-purpose") && got[0].updated_ms > 0);
        let _ = fs::remove_dir_all(&projects);
    }

    #[test]
    fn missing_project_session_or_subagents_gives_an_empty_list() {
        let projects = tmp("empty");
        assert!(subagent_files(&projects, "/nope").is_empty());
        let project = projects.join("-w-app");
        fs::create_dir_all(&project).unwrap();
        assert!(subagent_files(&projects, "/w/app").is_empty());
        fs::write(project.join("s.jsonl"), "{}").unwrap();
        assert!(subagent_files(&projects, "/w/app").is_empty());
        assert!(subagent_files(&projects.join("missing"), "/w/app").is_empty());
        let _ = fs::remove_dir_all(&projects);
    }
}
