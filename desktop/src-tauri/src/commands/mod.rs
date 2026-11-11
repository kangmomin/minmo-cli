pub mod fs;
pub mod git;
#[cfg(windows)]
pub mod job;
pub mod keychain;
pub mod pty;
pub mod script;

/// 경로 비교용 정규화: 구분자 통일 + 끝 구분자 제거 + (Windows) 대소문자 무시
pub(crate) fn normalize_path(p: &str) -> String {
    let unified = p.replace('\\', "/");
    let trimmed = unified.trim_end_matches('/');
    let s = if trimmed.is_empty() { "/" } else { trimmed };
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// child 가 parent 와 같거나 그 하위인지
pub(crate) fn is_same_or_inside(child: &str, parent: &str) -> bool {
    let c = normalize_path(child);
    let p = normalize_path(parent);
    c == p || c.starts_with(&format!("{}/", p.trim_end_matches('/')))
}

/// Windows 에서 GUI 앱이 자식 프로세스를 띄울 때 콘솔 창이 깜빡이지 않도록 하는 플래그
#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// pid 와 그 자손 프로세스를 모두 강제 종료하고 taskkill 이 끝날 때까지 기다린다
#[cfg(windows)]
pub(crate) fn taskkill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}
