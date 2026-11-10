// 데스크탑 Rust fs 커맨드와 같은 규칙: 넓은 범위를 지우지 않고, 덮어쓰지 않고, 심볼릭 링크를 따라가지 않는다.
import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'

function depth(p: string): number {
  return normalize(p).split(sep).filter(Boolean).length
}

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
  if (normalize(home) === root) throw new Error('홈 디렉터리는 삭제하지 않습니다')
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
    await mkdir(join(d, ...parts), { recursive: true })
    await copyFile(join(s, rel), target)
    copied++
  }
  return copied
}
