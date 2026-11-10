// 파일 시스템·플랫폼 정보
use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn home_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// 프론트 Platform 타입과 같은 값 ('win32' | 'darwin' | 'linux')
#[tauri::command]
pub fn os_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// 재귀 삭제 — EC-10 "이번 실행이 새로 만든 경로" 정리 전용.
/// 실수로 넓은 범위를 지우지 않도록 상대 경로·루트·홈 디렉터리와 얕은 경로(구성 요소 3개 미만)는 거부한다.
#[tauri::command]
pub fn remove_dir(app: AppHandle, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_absolute() {
        return Err(format!("절대 경로만 삭제할 수 있습니다: {path}"));
    }
    let depth = p
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    if depth < 3 {
        return Err(format!("너무 상위 경로라 삭제하지 않습니다: {path}"));
    }
    if let Ok(home) = app.path().home_dir() {
        if super::normalize_path(&home.to_string_lossy()) == super::normalize_path(&path) {
            return Err("홈 디렉터리는 삭제하지 않습니다".to_string());
        }
    }
    if !p.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(p).map_err(|e| e.to_string())
}

// ── 레포별 로컬 파일 보관 폴더(.env 등 git 에 올리지 않는 파일) ──

/// 보관·복사 대상 루트는 절대 경로이고 구성 요소가 3개 이상이어야 한다(remove_dir 과 같은 기준)
fn guard_root(path: &str) -> Result<&Path, String> {
    let p = Path::new(path);
    let depth = p
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    if !p.is_absolute() || depth < 3 {
        return Err(format!("허용되지 않는 경로입니다: {path}"));
    }
    Ok(p)
}

/// 루트 기준 상대 경로만 받는다. 절대 경로·`..`·드라이브 접두로 루트 밖을 가리키지 못하게 한다
fn safe_rel(rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel.trim());
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => return Err(format!("저장소 기준 상대 경로만 쓸 수 있습니다: {rel}")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err("경로가 비어 있습니다".to_string());
    }
    Ok(out)
}

fn walk_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        // 심볼릭 링크는 따라가지 않는다 — 보관 폴더 밖의 파일이 복사되는 것을 막는다
        let ty = entry.file_type()?;
        if ty.is_dir() {
            walk_files(root, &entry.path(), out)?;
        } else if ty.is_file() {
            if let Ok(rel) = entry.path().strip_prefix(root) {
                out.push(rel.to_path_buf());
            }
        }
    }
    Ok(())
}

fn rel_string(p: &Path) -> String {
    p.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// src 의 파일을 dst 의 같은 상대 경로로 복사한다. 이미 있는 파일은 덮어쓰지 않는다(체크아웃된 파일 보호)
fn copy_tree_impl(src: &Path, dst: &Path) -> std::io::Result<u32> {
    if !src.is_dir() {
        return Ok(0);
    }
    let mut files = Vec::new();
    walk_files(src, src, &mut files)?;
    let mut copied = 0;
    for rel in files {
        let target = dst.join(&rel);
        if target.exists() {
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src.join(&rel), &target)?;
        copied += 1;
    }
    Ok(copied)
}

fn list_files_impl(root: &Path) -> std::io::Result<Vec<String>> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    walk_files(root, root, &mut files)?;
    let mut out: Vec<String> = files.iter().map(|p| rel_string(p)).collect();
    out.sort();
    Ok(out)
}

/// 새 worktree 에 보관 폴더 내용을 복사하고 복사한 파일 수를 돌려준다
#[tauri::command]
pub fn copy_tree(src: String, dst: String) -> Result<u32, String> {
    let src = guard_root(&src)?;
    let dst = guard_root(&dst)?;
    copy_tree_impl(src, dst).map_err(|e| e.to_string())
}

/// root 아래 파일의 상대 경로('/' 구분, 정렬). root 가 없으면 빈 목록
#[tauri::command]
pub fn list_files(root: String) -> Result<Vec<String>, String> {
    list_files_impl(guard_root(&root)?).map_err(|e| e.to_string())
}

/// src_root/rel 파일을 dst_root/rel 로 복사한다(덮어씀). 보관 폴더에 최신 .env 를 저장할 때 쓴다
#[tauri::command]
pub fn copy_file_into(src_root: String, rel: String, dst_root: String) -> Result<(), String> {
    let rel = safe_rel(&rel)?;
    let src = guard_root(&src_root)?.join(&rel);
    let dst = guard_root(&dst_root)?.join(&rel);
    if !src.is_file() {
        return Err(format!("파일이 없습니다: {}", rel_string(&rel)));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&src, &dst)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_file_in(root: String, rel: String) -> Result<(), String> {
    let rel = safe_rel(&rel)?;
    let p = guard_root(&root)?.join(&rel);
    if !p.is_file() {
        return Ok(());
    }
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

/// 폴더를 OS 파일 탐색기로 연다. 없으면 먼저 만든다(빈 보관 폴더 열기)
#[tauri::command]
pub fn open_dir(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = guard_root(&path)?;
    std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(path.clone(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir()
            .join("minmo-fs-test")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn safe_rel_rejects_escape() {
        assert!(safe_rel(".env").is_ok());
        assert_eq!(
            rel_string(&safe_rel("./config/local.json").unwrap()),
            "config/local.json"
        );
        for bad in ["", "../x", "a/../../x", "/etc/passwd", r"C:\x", "C:/x"] {
            if cfg!(not(windows)) && bad.starts_with("C:") {
                continue; // 유닉스에서 C: 는 일반 이름
            }
            assert!(safe_rel(bad).is_err(), "{bad} 는 거부돼야 한다");
        }
    }

    #[test]
    fn guard_root_rejects_shallow_or_relative() {
        assert!(guard_root("rel/a/b").is_err());
        let shallow = if cfg!(windows) { r"C:\a" } else { "/a" };
        assert!(guard_root(shallow).is_err());
    }

    #[test]
    fn copy_tree_keeps_existing_files_and_nested_paths() {
        let base = tmp("copy");
        let (src, dst) = (base.join("_local"), base.join("wt"));
        std::fs::create_dir_all(src.join("config")).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join(".env"), "A=1").unwrap();
        std::fs::write(src.join("config/local.json"), "{}").unwrap();
        std::fs::write(dst.join(".env"), "A=checked-in").unwrap();

        assert_eq!(copy_tree_impl(&src, &dst).unwrap(), 1);
        assert_eq!(
            std::fs::read_to_string(dst.join(".env")).unwrap(),
            "A=checked-in"
        );
        assert_eq!(
            std::fs::read_to_string(dst.join("config/local.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            list_files_impl(&src).unwrap(),
            vec![".env", "config/local.json"]
        );
        // 보관 폴더가 없으면 0개, 오류 아님
        assert_eq!(copy_tree_impl(&base.join("none"), &dst).unwrap(), 0);
        assert!(list_files_impl(&base.join("none")).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }
}
