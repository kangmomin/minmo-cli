// 변경 탭: status/diff, 선택 스테이징·커밋, push, PR (F-05)
import type { GitHubClient } from '../../lib/github'
import type { TauriApi } from '../../lib/tauri'

export type FileChange = {
  path: string
  /** rename/copy 원본 경로 */
  origPath?: string
  /** porcelain XY (untracked 는 '??') */
  xy: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

export type PrIssue = { number: number | null; title: string }
export type PrDraft = { title: string; body: string; draft: boolean; titleRequired: boolean }

export type GitErrorCode = 'permission_denied' | 'push_rejected' | 'title_required' | 'nothing_selected' | 'git_failed'

export class GitError extends Error {
  code: GitErrorCode
  /** git/gh stderr 전문 (EC-12: 오류 전문 표시) */
  stderr?: string
  constructor(code: GitErrorCode, init?: { message?: string; stderr?: string }) {
    super(init?.message ?? code)
    this.name = 'GitError'
    this.code = code
    if (init?.stderr !== undefined) this.stderr = init.stderr
  }
}

export type CreatePrRequest = {
  owner: string
  repo: string
  branch: string
  issue: PrIssue
  title: string
  body: string
  draft: boolean
}
export type PrResult = { url: string; number: number; existing: boolean }

export interface GitOpsDeps {
  tauri: Pick<TauriApi, 'gitRun'>
  github: Pick<GitHubClient, 'defaultBranch' | 'openPrForBranch' | 'createPr'>
}

export interface GitOps {
  status(cwd: string): Promise<FileChange[]>
  diff(cwd: string, path: string, opts?: { staged?: boolean }): Promise<string>
  /** 선택 파일만 스테이징·커밋 (AC-09) */
  commit(cwd: string, paths: string[], message: string): Promise<{ hash: string }>
  /** git push -u origin <branch>, force 금지 (AC-10, EC-12) */
  push(cwd: string, branch: string): Promise<void>
  unpushedCount(cwd: string): Promise<number>
  /** 열린 PR 있으면 그 PR (EC-13), 없으면 생성 (AC-11, EC-14) */
  createOrOpenPr(req: CreatePrRequest): Promise<PrResult>
}

const notImplemented = (): never => {
  throw new Error('not implemented')
}

// STUB (Phase 6.1 Red)
/** git status --porcelain=v2 출력 파싱 (헤더 '#' 무시) */
export function parsePorcelainV2(_stdout: string): FileChange[] {
  return notImplemented()
}

/** PR 다이얼로그 초기값: 이슈 → title=이슈 제목, body 'Closes #n', draft / 기타 → title '', Closes 없음, title 필수 */
export function buildPrDraft(_issue: PrIssue): PrDraft {
  return notImplemented()
}

export function createGitOps(_deps: GitOpsDeps): GitOps {
  const fail = async (): Promise<never> => notImplemented()
  return { status: fail, diff: fail, commit: fail, push: fail, unpushedCount: fail, createOrOpenPr: fail }
}

export type UseGitTarget = { owner: string; repo: string; branch: string; cwd: string; issue: PrIssue }

/** ChangesTab 용 훅 (TanStack Query 래핑) — 6.2 에서 구현 */
export function useGit(_target: UseGitTarget): {
  changes: FileChange[]
  unpushed: number
  ops: GitOps
} {
  return notImplemented()
}
