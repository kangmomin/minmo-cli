// 파일 시스템·플랫폼 정보
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
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
    // `..` 가 섞이면 깊이 검사를 통과해도 실제로는 상위(드라이브 루트 등)를 가리킬 수 있다
    if has_parent_dir(p) {
        return Err(format!("`..` 가 포함된 경로는 삭제하지 않습니다: {path}"));
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

fn has_parent_dir(p: &Path) -> bool {
    p.components().any(|c| matches!(c, Component::ParentDir))
}

/// 보관·복사 대상 루트는 `..` 없는 절대 경로이고 구성 요소가 3개 이상이어야 한다(remove_dir 과 같은 기준)
fn guard_root(path: &str) -> Result<&Path, String> {
    let p = Path::new(path);
    let depth = p
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    if !p.is_absolute() || depth < 3 || has_parent_dir(p) {
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

fn is_symlink(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
}

/// root 아래 rel 경로의 중간 폴더 중 심볼릭 링크가 있는지 — 저장소에 커밋된 링크를 따라 root 밖에 쓰지 않게 한다
fn has_symlink_between(root: &Path, rel: &Path) -> bool {
    let mut cur = root.to_path_buf();
    rel.parent()
        .into_iter()
        .flat_map(|p| p.components())
        .any(|c| {
            cur.push(c);
            is_symlink(&cur)
        })
}

/// src 의 파일을 dst 의 같은 상대 경로로 복사한다. 이미 있는 파일(깨진 링크 포함)은 덮어쓰지 않고(체크아웃된 파일 보호),
/// 대상 경로에 심볼릭 링크가 끼어 있으면 건너뛴다
fn copy_tree_impl(src: &Path, dst: &Path) -> std::io::Result<u32> {
    if !src.is_dir() {
        return Ok(0);
    }
    let mut files = Vec::new();
    walk_files(src, src, &mut files)?;
    let mut copied = 0;
    for rel in files {
        let target = dst.join(&rel);
        if std::fs::symlink_metadata(&target).is_ok() || has_symlink_between(dst, &rel) {
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
    // 저장소에 커밋된 링크(.env → ~/.ssh/... 등)를 따라 다른 파일을 보관하지 않는다
    if is_symlink(&src) || has_symlink_between(guard_root(&src_root)?, &rel) {
        return Err(format!(
            "심볼릭 링크는 보관할 수 없습니다: {}",
            rel_string(&rel)
        ));
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

// ── 파일 탭: worktree 안의 파일 보기·편집 ──

/// 편집기로 여는 파일 크기 상한
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    /// dir | file | link
    kind: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    content: String,
    /// 저장할 때 그 사이 바뀌었는지 비교하는 값(뜻은 없다)
    version: String,
}

/// root 아래 rel 의 실제 경로. 중간에 심볼릭 링크가 끼어 있으면 거부한다(커밋된 링크로 worktree 밖을 건드리지 않게).
/// rel 이 비면 root 자신
fn resolve_in(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = guard_root(root)?;
    if rel.trim().is_empty() {
        return Ok(root.to_path_buf());
    }
    let rel = safe_rel(rel)?;
    if has_symlink_between(root, &rel) {
        return Err(format!(
            "심볼릭 링크를 지나는 경로는 쓸 수 없습니다: {}",
            rel_string(&rel)
        ));
    }
    Ok(root.join(rel))
}

fn version_of(p: &Path) -> std::io::Result<String> {
    let m = std::fs::metadata(p)?;
    let ms = m
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(format!("{ms}:{}", m.len()))
}

fn list_dir_impl(dir: &Path) -> std::io::Result<Vec<DirEntry>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        // 저장소 내부 데이터는 편집 대상이 아니다
        if name == ".git" {
            continue;
        }
        let ty = entry.file_type()?;
        let kind = if ty.is_symlink() {
            "link"
        } else if ty.is_dir() {
            "dir"
        } else {
            "file"
        };
        out.push(DirEntry { name, kind });
    }
    out.sort_by(|a, b| {
        (a.kind != "dir", a.name.to_lowercase(), &a.name).cmp(&(
            b.kind != "dir",
            b.name.to_lowercase(),
            &b.name,
        ))
    });
    Ok(out)
}

/// 폴더 내용(폴더 먼저, 이름순). rel 이 비면 root
#[tauri::command]
pub fn fs_list_dir(root: String, rel: String) -> Result<Vec<DirEntry>, String> {
    let dir = resolve_in(&root, &rel)?;
    // 링크된 폴더는 열지 않는다(worktree 밖을 보여 주지 않게 — 원격 구현과 같은 규칙)
    if !rel.trim().is_empty() && is_symlink(&dir) {
        return Err("심볼릭 링크를 지나는 경로는 쓸 수 없습니다".into());
    }
    list_dir_impl(&dir).map_err(|e| e.to_string())
}

/// 텍스트 파일 읽기. 실패 사유는 코드로 시작한다: file_too_large · file_binary · file_link
#[tauri::command]
pub fn fs_read_text(root: String, rel: String) -> Result<TextFile, String> {
    let p = resolve_in(&root, &rel)?;
    if is_symlink(&p) {
        return Err("file_link: 심볼릭 링크는 열 수 없습니다".into());
    }
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("파일이 아닙니다".into());
    }
    if meta.len() > MAX_TEXT_BYTES {
        return Err("file_too_large: 2MB 보다 큰 파일은 열 수 없습니다".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("file_binary: 텍스트 파일이 아닙니다".into());
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| "file_binary: UTF-8 텍스트 파일이 아닙니다".to_string())?;
    Ok(TextFile {
        content,
        version: version_of(&p).map_err(|e| e.to_string())?,
    })
}

/// 텍스트 파일 저장. expected 가 있으면 읽은 뒤 바뀌지 않았을 때만 쓴다(file_changed), create 면 새 파일만(file_exists).
/// 쓰다가 끊겨도 원본이 깨지지 않게 같은 폴더의 임시 파일에 쓴 뒤 바꾼다. 새 version 을 돌려준다
#[tauri::command]
pub fn fs_write_text(
    root: String,
    rel: String,
    content: String,
    expected: Option<String>,
    create: bool,
) -> Result<String, String> {
    let p = resolve_in(&root, &rel)?;
    if p == guard_root(&root)? {
        return Err("경로가 비어 있습니다".into());
    }
    if is_symlink(&p) {
        return Err("file_link: 심볼릭 링크에는 쓸 수 없습니다".into());
    }
    let exists = p.exists();
    if create && exists {
        return Err("file_exists: 같은 이름이 이미 있습니다".into());
    }
    if exists && !p.is_file() {
        return Err("파일이 아닙니다".into());
    }
    if let (Some(want), true) = (&expected, exists) {
        if &version_of(&p).map_err(|e| e.to_string())? != want {
            return Err("file_changed: 연 뒤에 파일이 바뀌었습니다".into());
        }
    }
    let parent = p.parent().ok_or("경로가 올바르지 않습니다")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    // 같은 폴더에 동시에 저장해도 임시 파일이 겹치지 않게 번호를 붙인다
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = parent.join(format!(
        ".minmo-tmp-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let write = || -> std::io::Result<()> {
        std::fs::write(&tmp, content.as_bytes())?;
        // 실행 권한 등 원래 권한을 유지한다
        if exists {
            std::fs::set_permissions(&tmp, std::fs::metadata(&p)?.permissions())?;
        }
        std::fs::rename(&tmp, &p)
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    version_of(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_create_dir(root: String, rel: String) -> Result<(), String> {
    let p = resolve_in(&root, &rel)?;
    if std::fs::symlink_metadata(&p).is_ok() {
        return Err("file_exists: 같은 이름이 이미 있습니다".into());
    }
    std::fs::create_dir_all(p).map_err(|e| e.to_string())
}

/// 이름 바꾸기·옮기기. 대상이 이미 있으면 덮어쓰지 않는다
#[tauri::command]
pub fn fs_rename(root: String, from: String, to: String) -> Result<(), String> {
    let base = guard_root(&root)?.to_path_buf();
    let src = resolve_in(&root, &from)?;
    let dst = resolve_in(&root, &to)?;
    if src == base || dst == base {
        return Err("경로가 비어 있습니다".into());
    }
    if std::fs::symlink_metadata(&src).is_err() {
        return Err("대상이 없습니다".into());
    }
    if std::fs::symlink_metadata(&dst).is_ok() {
        return Err("file_exists: 같은 이름이 이미 있습니다".into());
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(src, dst).map_err(|e| e.to_string())
}

/// 파일 또는 폴더(하위 포함) 삭제. root 자신은 지우지 않는다. 심볼릭 링크는 링크만 지운다
#[tauri::command]
pub fn fs_remove(root: String, rel: String) -> Result<(), String> {
    let p = resolve_in(&root, &rel)?;
    if p == guard_root(&root)? {
        return Err("경로가 비어 있습니다".into());
    }
    let Ok(meta) = std::fs::symlink_metadata(&p) else {
        return Ok(());
    };
    if meta.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root_of(name: &str) -> (PathBuf, String) {
        let d = tmp(name);
        let s = d.to_string_lossy().into_owned();
        (d, s)
    }

    #[test]
    fn file_tab_lists_reads_and_writes_inside_the_root() {
        let (d, root) = root_of("filetab");
        std::fs::create_dir_all(d.join(".git")).unwrap();
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::write(d.join("b.txt"), "b").unwrap();
        std::fs::write(d.join("A.md"), "# a\r\n한글").unwrap();
        let names: Vec<(String, &str)> = fs_list_dir(root.clone(), String::new())
            .unwrap()
            .into_iter()
            .map(|e| (e.name, e.kind))
            .collect();
        assert_eq!(
            names,
            [
                ("src".to_string(), "dir"),
                ("A.md".to_string(), "file"),
                ("b.txt".to_string(), "file")
            ]
        );

        let f = fs_read_text(root.clone(), "A.md".into()).unwrap();
        assert_eq!(f.content, "# a\r\n한글");
        // 읽은 뒤 바뀌지 않았으면 저장되고 새 version 을 받는다
        let v2 = fs_write_text(
            root.clone(),
            "A.md".into(),
            "new".into(),
            Some(f.version.clone()),
            false,
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(d.join("A.md")).unwrap(), "new");
        // 예전 version 으로는 거부된다(그 사이 바뀜)
        std::fs::write(d.join("A.md"), "changed outside!").unwrap();
        let err =
            fs_write_text(root.clone(), "A.md".into(), "x".into(), Some(v2), false).unwrap_err();
        assert!(err.starts_with("file_changed"), "{err}");
        assert_eq!(
            std::fs::read_to_string(d.join("A.md")).unwrap(),
            "changed outside!"
        );

        // 새 파일(중간 폴더 포함) · 이미 있으면 거부
        fs_write_text(root.clone(), "new/dir/x.txt".into(), "x".into(), None, true).unwrap();
        assert!(d.join("new/dir/x.txt").is_file());
        assert!(
            fs_write_text(root.clone(), "b.txt".into(), "x".into(), None, true)
                .unwrap_err()
                .starts_with("file_exists")
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn file_tab_rejects_binary_large_and_escaping_paths() {
        let (d, root) = root_of("filetab-bad");
        std::fs::write(d.join("bin"), [0u8, 1, 2]).unwrap();
        std::fs::write(d.join("latin1"), [0xE9u8, 0x20]).unwrap();
        std::fs::write(d.join("big"), vec![b'a'; (MAX_TEXT_BYTES + 1) as usize]).unwrap();
        for (name, code) in [
            ("bin", "file_binary"),
            ("latin1", "file_binary"),
            ("big", "file_too_large"),
        ] {
            let err = fs_read_text(root.clone(), name.into()).err().unwrap();
            assert!(err.starts_with(code), "{name}: {err}");
        }
        for bad in ["../x", "/etc/passwd", "a/../../x"] {
            assert!(fs_read_text(root.clone(), bad.into()).is_err());
            assert!(fs_write_text(root.clone(), bad.into(), "x".into(), None, false).is_err());
            assert!(fs_remove(root.clone(), bad.into()).is_err());
            assert!(fs_rename(root.clone(), "bin".into(), bad.into()).is_err());
        }
        // root 자신은 지우거나 덮어쓰지 않는다
        assert!(fs_remove(root.clone(), String::new()).is_err());
        assert!(fs_write_text(root.clone(), String::new(), "x".into(), None, false).is_err());
        assert!(d.is_dir());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn file_tab_creates_renames_and_removes() {
        let (d, root) = root_of("filetab-ops");
        fs_create_dir(root.clone(), "a/b".into()).unwrap();
        assert!(fs_create_dir(root.clone(), "a".into())
            .unwrap_err()
            .starts_with("file_exists"));
        std::fs::write(d.join("a/b/f.txt"), "f").unwrap();
        fs_rename(root.clone(), "a/b/f.txt".into(), "c/g.txt".into()).unwrap();
        assert!(d.join("c/g.txt").is_file());
        std::fs::write(d.join("other.txt"), "o").unwrap();
        assert!(
            fs_rename(root.clone(), "other.txt".into(), "c/g.txt".into())
                .unwrap_err()
                .starts_with("file_exists")
        );
        fs_remove(root.clone(), "a".into()).unwrap();
        fs_remove(root.clone(), "c/g.txt".into()).unwrap();
        fs_remove(root.clone(), "missing".into()).unwrap();
        assert!(!d.join("a").exists() && !d.join("c/g.txt").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn file_tab_does_not_follow_symlinked_folders() {
        let (d, root) = root_of("filetab-link");
        let outside = tmp("filetab-outside");
        std::fs::write(outside.join("secret"), "s").unwrap();
        std::os::unix::fs::symlink(&outside, d.join("link")).unwrap();
        assert!(fs_read_text(root.clone(), "link/secret".into()).is_err());
        assert!(fs_write_text(root.clone(), "link/new".into(), "x".into(), None, true).is_err());
        assert!(fs_remove(root.clone(), "link/secret".into()).is_err());
        assert!(fs_list_dir(root.clone(), "link".into()).is_err());
        // 링크 자체는 지울 수 있고, 가리키던 곳은 그대로다
        fs_remove(root.clone(), "link".into()).unwrap();
        assert!(outside.join("secret").is_file());
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&outside);
    }

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
        let up = std::env::temp_dir().join("a/b/c/../../../..");
        assert!(
            guard_root(&up.to_string_lossy()).is_err(),
            "`..` 로 상위를 가리키면 거부"
        );
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

    /// 심볼릭 링크는 권한(개발자 모드)이 필요해 권한 없이 만들 수 있는 junction 으로 대신한다
    #[cfg(windows)]
    fn symlink_dir(target: &Path, link: &Path) -> std::io::Result<()> {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return Ok(());
        }
        let status = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other("mklink /J 실패"))
        }
    }
    #[cfg(unix)]
    fn symlink_dir(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    /// 저장소에 커밋된 디렉터리 링크(config -> 밖)를 따라 보관 파일을 worktree 밖에 쓰지 않는다
    #[test]
    fn copy_tree_skips_paths_through_symlinks() {
        let base = tmp("symlink");
        let (src, dst, outside) = (base.join("_local"), base.join("wt"), base.join("outside"));
        std::fs::create_dir_all(src.join("config")).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(src.join("config/local.json"), "{}").unwrap();
        if symlink_dir(&outside, &dst.join("config")).is_err() {
            eprintln!("심볼릭 링크를 만들 권한이 없어 건너뜀");
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        assert_eq!(copy_tree_impl(&src, &dst).unwrap(), 0);
        assert!(
            !outside.join("local.json").exists(),
            "링크를 따라 worktree 밖에 썼다"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
