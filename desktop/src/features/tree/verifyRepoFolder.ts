// 사용자가 고른 폴더가 기준 저장소로 쓸 수 있는 git 저장소인지 확인한다(기준 저장소 지정·폴더 열기 공용).
import { expandHome, normalizePath } from '@minmo/api-client'
import type { Platform } from '@minmo/api-client'

import type { TauriApi } from '../../lib/tauri'

/** git remote 주소에서 "owner/repo" 를 뽑는다(https·ssh 형식, 호스트는 가리지 않는다). 알 수 없으면 null */
export function repoOfRemote(url: string): string | null {
  const m = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/**
 * github.com 의 저장소 주소일 때만 owner·name 을 돌려준다 — GitLab 등 다른 곳의 주소를 GitHub 저장소로 잘못 보지 않게.
 * (~/.ssh/config 의 별칭을 호스트로 쓴 주소는 알 수 없어 null)
 */
export function githubRepoOfRemote(url: string): { owner: string; name: string } | null {
  const m = /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return m ? { owner: m[1], name: m[2] } : null
}

/** 그 OS 의 절대 경로인가 */
export function isAbsolutePath(path: string, platform: Platform): boolean {
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') : path.startsWith('/')
}

/** 입력한 경로를 실제 경로로(~ 풀기, 끝 구분자 제거). 쓸 수 없으면 사유 */
export function resolveInputPath(raw: string, env: { home: string; platform: Platform }): { path: string } | { error: string } {
  const trimmed = raw.trim()
  const stripped = expandHome(trimmed, env.home, env.platform).replace(/[\\/]+$/, '')
  // 끝 구분자를 떼면 루트가 사라진다(/ → '', C:\\ → C:) → 되돌린다
  const full = stripped === '' && trimmed !== '' ? '/' : /^[A-Za-z]:$/.test(stripped) ? `${stripped}\\` : stripped
  if (trimmed === '' || !isAbsolutePath(full, env.platform)) return { error: '절대 경로(또는 ~ 로 시작하는 경로)를 입력하세요' }
  // 경로는 설정의 경로 템플릿 자리에 들어가므로 템플릿 기호는 쓸 수 없다
  if (/[{}]/.test(full)) return { error: '경로에 { } 를 쓸 수 없습니다' }
  return { path: full }
}

export type RepoFolder = {
  /** git 이 돌려준 최상위 경로 — 나중에 git 이 알려 주는 경로와 같은 모양이라 비교가 어긋나지 않는다 */
  top: string
  /** origin 주소(없으면 null) */
  origin: string | null
  hasCommits: boolean
}

export type VerifyResult = ({ ok: true } & RepoFolder) | { ok: false; error: string }

export async function verifyRepoFolder(tauri: Pick<TauriApi, 'gitRun'>, env: { home: string; platform: Platform }, raw: string): Promise<VerifyResult> {
  const resolved = resolveInputPath(raw, env)
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const full = resolved.path
  // 작업 폴더가 있는 일반 저장소의 최상위만 받는다 — 하위 폴더·다른 저장소의 worktree·bare 저장소는 보관 폴더(.git 안)와
  // 삭제 때의 저장소 찾기가 어긋난다
  const git = await tauri.gitRun(['-C', full, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])
  if (git.code !== 0) return { ok: false, error: `git 저장소(작업 폴더)가 아닙니다: ${git.stderr.trim() || full}` }
  const [top = '', common = ''] = git.stdout.split(/\r?\n/)
  const same = (a: string, b: string) => normalizePath(a, env.platform) === normalizePath(b, env.platform)
  if (!same(top, full)) return { ok: false, error: `저장소의 최상위 폴더를 지정하세요: ${top}` }
  if (!same(common, `${top}/.git`)) return { ok: false, error: '다른 저장소에 딸린 worktree 입니다 — 원래 저장소 폴더를 지정하세요' }
  const [origin, head] = await Promise.all([
    tauri.gitRun(['-C', full, 'remote', 'get-url', 'origin']),
    tauri.gitRun(['-C', full, 'rev-parse', '--verify', '--quiet', 'HEAD']),
  ])
  return { ok: true, top, origin: origin.code === 0 && origin.stdout.trim() !== '' ? origin.stdout.trim() : null, hasCommits: head.code === 0 }
}

/** 경로의 마지막 폴더 이름 */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}

/** "owner/name" 또는 GitHub 주소 → 저장소 */
export function parseGitHubRepo(input: string): { owner: string; name: string } | null {
  const text = input.trim()
  const fromUrl = githubRepoOfRemote(text)
  if (fromUrl) return fromUrl
  const m = /^([A-Za-z0-9][A-Za-z0-9_-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(text)
  return m ? { owner: m[1], name: m[2] } : null
}
