// 데스크탑 Rust fs 커맨드와 같은 규칙: 넓은 범위를 지우지 않고, 덮어쓰지 않고, 심볼릭 링크를 따라가지 않는다.
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, parse, relative, sep } from 'node:path'

/** 루트(`/`·`C:\`·UNC)를 뺀 구성 요소 수 — Rust fs.rs 가 Component::Normal 만 세는 것과 같다 */
function depth(p: string): number {
  const n = normalize(p)
  return n.slice(parse(n).root.length).split(sep).filter(Boolean).length
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/** 절대 경로·`..` 없음·구성 요소 3개 이상 — 실수로 홈이나 루트를 건드리지 않게 */
export function guardRoot(p: string): string {
  if (!isAbsolute(p) || p.split(/[\\/]/).includes('..') || depth(p) < 3) throw new Error(`허용되지 않는 경로입니다: ${p}`)
  return normalize(p)
}

export async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p)
    return true
  } catch {
    return false
  }
}

async function isSymlink(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymbolicLink()
  } catch {
    return false
  }
}

/** "이번 실행이 새로 만든 경로" 정리 전용 재귀 삭제 */
export async function removeDir(p: string, home = homedir()): Promise<void> {
  const root = guardRoot(p)
  if (samePath(normalize(home), root)) throw new Error('홈 디렉터리는 삭제하지 않습니다')
  await rm(root, { recursive: true, force: true })
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    // Dirent 는 링크를 따라가지 않는다 — 보관 폴더 밖 파일이 복사되지 않게
    if (e.isDirectory()) await walk(root, full, out)
    else if (e.isFile()) out.push(relative(root, full))
  }
}

/** src 의 파일을 dst 의 같은 상대 경로로 복사한다. 이미 있는 파일(깨진 링크 포함)은 두고, 경로에 링크가 끼면 건너뛴다 */
export async function copyTree(src: string, dst: string): Promise<number> {
  const s = guardRoot(src)
  const d = guardRoot(dst)
  if (!(await exists(s)) || !(await lstat(s)).isDirectory()) return 0
  const files: string[] = []
  await walk(s, s, files)
  return copyFiles(s, d, files)
}

/** 원본 쪽 경로 중간에 링크가 끼었는가 — 링크를 타고 src 밖의 파일을 읽지 않게 */
async function linkedUnder(root: string, parts: string[]): Promise<boolean> {
  let cur = root
  for (const part of parts) {
    cur = join(cur, part)
    if (await isSymlink(cur)) return true
  }
  return false
}

const foldName = (n: string) => (process.platform === 'linux' ? n : n.toLowerCase())

/** 실패를 모아 끝까지 간다 — 무시된 폴더는 무엇이 들어 있을지 모른다(읽지 못하는 폴더, 잠긴 파일) */
type Failures = { count: number; first?: string }
const failed = (f: Failures, rel: string, e: unknown) => {
  f.count++
  f.first ??= `${rel}: ${e instanceof Error ? e.message : String(e)}`
}

/** walk 와 같되 skip 에 있는 이름·`.git` 은 내려가지 않고, 읽지 못한 폴더는 실패로 세고 넘어간다 */
async function walkSkipping(root: string, dir: string, out: string[], skip: ReadonlySet<string>, f: Failures): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    return failed(f, relative(root, dir), e)
  }
  for (const e of entries) {
    if (skip.has(foldName(e.name))) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await walkSkipping(root, full, out, skip, f)
    else if (e.isFile()) out.push(relative(root, full))
  }
}

/**
 * src 아래의 상대 경로들(파일 또는 폴더)을 dst 의 같은 위치로 복사한다 — 새 worktree 에 무시된 파일을 가져올 때.
 * copyTree 와 같은 규칙(기존 파일 유지·링크 건너뜀). 없는 경로는 조용히 건너뛰고, 폴더 안의 skipNames·`.git` 은 내려가지 않는다.
 * 일부가 실패해도 나머지는 복사하고, 끝에 실패를 알린다
 */
export async function copyPaths(src: string, dst: string, rels: string[], skipNames: string[] = []): Promise<number> {
  const s = guardRoot(src)
  const d = guardRoot(dst)
  const skip = new Set(['.git', ...skipNames].map(foldName))
  const f: Failures = { count: 0 }
  const files: string[] = []
  for (const rel of rels) {
    const parts = rel.split('/')
    // `:` 은 Windows 에서만 드라이브·스트림 표시다(다른 OS 에서는 흔한 파일 이름 글자)
    const bad = (x: string) => x === '' || x === '.' || x === '..' || x.includes('\\') || (process.platform === 'win32' && x.includes(':'))
    if (rel === '' || isAbsolute(rel) || parts.some(bad)) throw new Error(`허용되지 않는 상대 경로입니다: ${rel}`)
    if (await linkedUnder(s, parts)) continue
    const full = join(s, ...parts)
    let st
    try {
      st = await lstat(full)
    } catch {
      continue
    }
    if (st.isDirectory()) await walkSkipping(s, full, files, skip, f)
    else if (st.isFile()) files.push(relative(s, full))
  }
  const copied = await copyFiles(s, d, files, f)
  if (f.first) throw new Error(`${copied}개 복사, ${f.count}개 실패 — ${f.first}`)
  return copied
}

/** f 를 주면 파일별 실패를 모으고 계속한다(없으면 첫 실패에서 멈춘다 — copyTree 의 기존 동작) */
async function copyFiles(s: string, d: string, files: string[], f?: Failures): Promise<number> {
  let copied = 0
  for (const rel of files) {
    const target = join(d, rel)
    if (await exists(target)) continue
    const parts = rel.split(sep).slice(0, -1)
    let cur = d
    let linked = false
    for (const part of parts) {
      cur = join(cur, part)
      if (await isSymlink(cur)) {
        linked = true
        break
      }
    }
    if (linked) continue
    try {
      await mkdir(join(d, ...parts), { recursive: true })
      // EXCL: 확인과 복사 사이에 생긴 파일도 덮어쓰지 않는다
      await copyFile(join(s, rel), target, constants.COPYFILE_EXCL)
      copied++
    } catch (e) {
      if (!f) throw e
      failed(f, rel, e)
    }
  }
  return copied
}
