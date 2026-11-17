// 사용자가 고른 폴더가 기준 저장소(원본 위치)로 쓸 수 있는 git 저장소인지 확인한다.
import { expandHome, normalizePath } from '@minmo/api-client'
import type { Platform } from '@minmo/api-client'

import type { GitHost } from './host'
import { isAbsoluteFor } from './worktree'

/** 입력한 경로를 실제 경로로(~ 풀기, 끝 구분자 제거). 쓸 수 없으면 사유 */
export function resolveInputPath(raw: string, env: { home: string; platform: Platform }): { path: string } | { error: string } {
  const trimmed = raw.trim()
  const stripped = expandHome(trimmed, env.home, env.platform).replace(/[\\/]+$/, '')
  // 끝 구분자를 떼면 루트가 사라진다(/ → '', C:\\ → C:) → 되돌린다
  const full = stripped === '' && trimmed !== '' ? '/' : /^[A-Za-z]:$/.test(stripped) ? `${stripped}\\` : stripped
  if (trimmed === '' || !isAbsoluteFor(full, env.platform)) return { error: '절대 경로(또는 ~ 로 시작하는 경로)를 입력하세요' }
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

export async function verifyRepoFolder(host: GitHost, env: { home: string; platform: Platform }, raw: string): Promise<VerifyResult> {
  const resolved = resolveInputPath(raw, env)
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const full = resolved.path
  // 작업 폴더가 있는 일반 저장소의 최상위만 받는다 — 하위 폴더·다른 저장소의 worktree·bare 저장소는 보관 폴더(.git 안)와
  // 삭제 때의 저장소 찾기가 어긋난다
  const git = await host.gitRun(['-C', full, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])
  if (git.code !== 0) return { ok: false, error: `git 저장소(작업 폴더)가 아닙니다: ${git.stderr.trim() || full}` }
  const [top = '', common = ''] = git.stdout.split(/\r?\n/)
  const same = (a: string, b: string) => normalizePath(a, env.platform) === normalizePath(b, env.platform)
  if (!same(top, full)) return { ok: false, error: `저장소의 최상위 폴더를 지정하세요: ${top}` }
  if (!same(common, `${top}/.git`)) return { ok: false, error: '다른 저장소에 딸린 worktree 입니다 — 원래 저장소 폴더를 지정하세요' }
  const [origin, head] = await Promise.all([
    host.gitRun(['-C', full, 'remote', 'get-url', 'origin']),
    host.gitRun(['-C', full, 'rev-parse', '--verify', '--quiet', 'HEAD']),
  ])
  return { ok: true, top, origin: origin.code === 0 && origin.stdout.trim() !== '' ? origin.stdout.trim() : null, hasCommits: head.code === 0 }
}

/** 기준 저장소의 로컬 파일 보관 폴더 — 기존 저장소의 옆 폴더는 다른 저장소와 겹칠 수 있어 그 저장소의 .git 안에 둔다 */
export function baseRepoLocalDir(main: string, platform: Platform): string {
  const sep = platform === 'win32' ? '\\' : '/'
  return `${main.replace(/[\\/]+$/, '')}${sep}.git${sep}minmo-local`
}

/**
 * 기기의 기본 폴더로 쓸 수 있는 입력인가(~ 는 쓸 때 푼다). 쓸 수 없으면 사유.
 * home 을 모르는 호스트(아직 연결하지 않은 원격)도 검사할 수 있게 ~ 는 풀지 않고 모양만 본다
 */
export function checkBaseDir(raw: string, platform: Platform): string | null {
  const v = raw.trim()
  if (v === '') return '경로를 입력하세요'
  if (/[{}]/.test(v)) return '경로에 { } 를 쓸 수 없습니다'
  const home = v === '~' || v.startsWith('~/') || (platform === 'win32' && v.startsWith('~\\'))
  if (!home && !isAbsoluteFor(v, platform)) return '절대 경로(또는 ~ 로 시작하는 경로)를 입력하세요'
  // 루트 바로 아래에 owner 폴더를 만들게 된다 — 실수일 가능성이 크고, 끝 구분자를 떼면 빈 값이 되어 적용되지도 않는다
  if (/^([A-Za-z]:)?[\\/]+$/.test(v)) return '루트 폴더는 쓸 수 없습니다 — 그 아래의 폴더를 지정하세요'
  return null
}
