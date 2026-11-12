// 프로세스 트리 조회 — 터미널(PTY)에서 지금 어떤 프로그램이 도는지(에이전트 감지) 알아낼 때 쓴다.

/// (pid, 부모 pid, 실행 파일 이름) 목록에서 root 의 자손들의 이름을 돌려준다(root 자신은 뺀다).
/// pid 재사용으로 부모 고리가 꼬여 있어도 한 번 본 pid 는 다시 보지 않는다.
pub(crate) fn descendants(procs: &[(u32, u32, String)], root: u32) -> Vec<String> {
    let mut names = Vec::new();
    let mut seen = std::collections::HashSet::from([root]);
    let mut queue = vec![root];
    while let Some(parent) = queue.pop() {
        for (pid, ppid, name) in procs {
            if *ppid == parent && seen.insert(*pid) {
                names.push(name.clone());
                queue.push(*pid);
            }
        }
    }
    names
}

/// root 의 자손 프로세스 이름들. 조회하지 못하면 빈 목록(감지는 터미널 제목만으로 한다)
pub(crate) fn descendant_names(root: u32) -> Vec<String> {
    descendants(&snapshot(), root)
}

#[cfg(windows)]
fn snapshot() -> Vec<(u32, u32, String)> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    // SAFETY: 스냅숏 핸들은 이 함수 안에서만 쓰고 닫는다. entry 는 dwSize 를 채운 뒤 넘긴다.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snap, &mut entry) != 0;
        while more {
            let len = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            out.push((
                entry.th32ProcessID,
                entry.th32ParentProcessID,
                String::from_utf16_lossy(&entry.szExeFile[..len]),
            ));
            more = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
    out
}

#[cfg(not(windows))]
fn snapshot() -> Vec<(u32, u32, String)> {
    let out = match std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,comm="])
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };
    parse_ps(&String::from_utf8_lossy(&out))
}

/// `ps -A -o pid=,ppid=,comm=` 출력 → (pid, ppid, 이름). comm 은 경로일 수 있어 마지막 조각만 쓴다
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn parse_ps(text: &str) -> Vec<(u32, u32, String)> {
    text.lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let ppid = it.next()?.parse().ok()?;
            let comm = it.collect::<Vec<_>>().join(" ");
            let name = comm.rsplit('/').next().unwrap_or(&comm).to_string();
            (!name.is_empty()).then_some((pid, ppid, name))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, ppid: u32, name: &str) -> (u32, u32, String) {
        (pid, ppid, name.to_string())
    }

    #[test]
    fn descendants_walks_the_tree_and_skips_root_and_others() {
        let procs = [
            p(10, 1, "powershell.exe"),
            p(11, 10, "node.exe"),
            p(12, 11, "codex.exe"),
            p(13, 10, "conhost.exe"),
            p(20, 1, "explorer.exe"),
            p(21, 20, "claude.exe"),
        ];
        let mut names = descendants(&procs, 10);
        names.sort();
        assert_eq!(names, ["codex.exe", "conhost.exe", "node.exe"]);
        assert!(descendants(&procs, 999).is_empty());
    }

    #[test]
    fn descendants_survives_parent_cycles() {
        // pid 재사용으로 서로를 부모로 가리키는 경우에도 끝난다
        let procs = [p(10, 11, "a"), p(11, 10, "b")];
        assert_eq!(descendants(&procs, 10), ["b"]);
    }

    #[test]
    fn parse_ps_reads_pid_ppid_and_basename() {
        let out = "  101     1 /usr/bin/zsh\n  202   101 claude\n  303   101 /opt/My App/bin/tool x\nbad line\n";
        assert_eq!(
            parse_ps(out),
            [
                p(101, 1, "zsh"),
                p(202, 101, "claude"),
                p(303, 101, "tool x")
            ]
        );
    }

    #[test]
    fn snapshot_contains_this_process() {
        let me = std::process::id();
        assert!(snapshot().iter().any(|(pid, _, _)| *pid == me));
    }
}
