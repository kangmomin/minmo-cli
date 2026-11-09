pub mod fs;
pub mod git;
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
