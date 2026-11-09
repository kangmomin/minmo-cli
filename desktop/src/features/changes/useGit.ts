// 변경 탭: status/diff, 선택 스테이징·커밋, push, PR (F-05)
import { useMemo } from 'react'

import { useQuery } from '@tanstack/react-query'

import { useDeps } from '../../app/deps'
import { GitHubError } from '../../lib/github'
import type { GitHubClient } from '../../lib/github'
import { queryKeys } from '../../lib/queryKeys'
import type { TauriApi } from '../../lib/tauri'
import { countUnpushed } from '../../lib/worktree'

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

/** git status --porcelain=v2 출력 파싱 (헤더 '#' 무시) */
export function parsePorcelainV2(stdout: string): FileChange[] {
  const out: FileChange[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('? ')) {
      out.push({ path: line.slice(2), xy: '??', staged: false, unstaged: false, untracked: true })
      continue
    }
    if (line.startsWith('! ')) continue // ignored
    const kind = line[0]
    // 1 XY sub mH mI mW hH hI path  /  2 XY sub mH mI mW hH hI Xscore path\torig  /  u XY sub m1 m2 m3 mW h1 h2 h3 path
    const fieldsBeforePath = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : -1
    if (fieldsBeforePath < 0) continue
    const parts = line.split(' ')
    const xy = parts[1] ?? '..'
    const rest = parts.slice(fieldsBeforePath).join(' ')
    let path = rest
    let origPath: string | undefined
    if (kind === '2') {
      const tab = rest.indexOf('\t')
      if (tab >= 0) {
        path = rest.slice(0, tab)
        origPath = rest.slice(tab + 1)
      }
    }
    const change: FileChange = {
      path,
      xy,
      staged: kind !== 'u' && xy[0] !== '.',
      unstaged: kind === 'u' || xy[1] !== '.',
      untracked: false,
    }
    if (origPath !== undefined) change.origPath = origPath
    out.push(change)
  }
  return out
}

/** PR 다이얼로그 초기값: 이슈 → title=이슈 제목, body 'Closes #n', draft / 기타 → title '', Closes 없음, title 필수 */
export function buildPrDraft(issue: PrIssue): PrDraft {
  if (issue.number === null) return { title: '', body: '', draft: true, titleRequired: true }
  return { title: issue.title, body: `Closes #${issue.number}`, draft: true, titleRequired: false }
}

function classifyPushError(stderr: string): GitErrorCode {
  if (/\[rejected\]|non-fast-forward|fetch first|\[remote rejected\]/i.test(stderr)) return 'push_rejected'
  if (/permission to .* denied|returned error: 403|permission denied|access denied/i.test(stderr)) return 'permission_denied'
  return 'git_failed'
}

export function createGitOps(deps: GitOpsDeps): GitOps {
  const git = (cwd: string, args: string[]) => deps.tauri.gitRun(['-C', cwd, ...args])

  async function gitOrThrow(cwd: string, args: string[]) {
    const r = await git(cwd, args)
    if (r.code !== 0) throw new GitError('git_failed', { message: r.stderr.trim() || `git ${args[0]} 실패`, stderr: r.stderr })
    return r
  }

  return {
    async status(cwd) {
      const r = await gitOrThrow(cwd, ['status', '--porcelain=v2', '--untracked-files=all'])
      return parsePorcelainV2(r.stdout)
    },

    async diff(cwd, path, opts) {
      const args = opts?.staged ? ['diff', '--cached', '--', path] : ['diff', '--', path]
      const r = await gitOrThrow(cwd, args)
      return r.stdout
    },

    async commit(cwd, paths, message) {
      if (paths.length === 0) throw new GitError('nothing_selected', { message: '커밋할 파일을 선택하세요' })
      // 선택 파일만 인덱스에 올리고, pathspec 으로 커밋 범위를 한정한다(이미 스테이징된 다른 파일 제외)
      await gitOrThrow(cwd, ['add', '--', ...paths])
      await gitOrThrow(cwd, ['commit', '-m', message, '--', ...paths])
      const head = await gitOrThrow(cwd, ['rev-parse', 'HEAD'])
      return { hash: head.stdout.trim() }
    },

    async push(cwd, branch) {
      // force 금지, 자동 재시도 없음 (EC-12)
      const r = await git(cwd, ['push', '-u', 'origin', branch])
      if (r.code !== 0) {
        const code = classifyPushError(r.stderr)
        throw new GitError(code, { message: r.stderr.trim() || 'push 실패', stderr: r.stderr })
      }
    },

    unpushedCount: (cwd) => countUnpushed(deps.tauri.gitRun, cwd),

    async createOrOpenPr(req) {
      if (req.issue.number === null && req.title.trim() === '') {
        throw new GitError('title_required', { message: 'PR 제목을 입력하세요' })
      }
      try {
        const existing = await deps.github.openPrForBranch(req.owner, req.repo, req.branch)
        if (existing) return { url: existing.url, number: existing.number, existing: true }
        const base = await deps.github.defaultBranch(req.owner, req.repo)
        const pr = await deps.github.createPr({
          owner: req.owner,
          repo: req.repo,
          base,
          head: req.branch,
          title: req.title.trim(),
          body: req.body,
          draft: req.draft,
        })
        return { url: pr.url, number: pr.number, existing: false }
      } catch (e) {
        // EC-11: 권한 없음 — fork 제안 없이 오류만
        if (e instanceof GitHubError && e.code === 'forbidden') {
          throw new GitError('permission_denied', { message: e.message })
        }
        throw e
      }
    },
  }
}

export type UseGitTarget = { owner: string; repo: string; branch: string; cwd: string; issue: PrIssue }

/** ChangesTab 용 훅 (TanStack Query 래핑) */
export function useGit(target: UseGitTarget): {
  changes: FileChange[]
  unpushed: number
  ops: GitOps
  isLoading: boolean
  error: unknown
  refresh(): Promise<void>
} {
  const { tauri, github } = useDeps()
  const ops = useMemo(() => createGitOps({ tauri, github }), [tauri, github])
  const status = useQuery({
    queryKey: queryKeys.gitStatus(target.cwd),
    queryFn: () => ops.status(target.cwd),
    // 로컬 명령이라 서버 retry 정책과 무관. [Assumption] 터미널에서 바꾼 파일을 반영하도록 5초 주기 갱신
    refetchInterval: 5000,
    retry: false,
  })
  const unpushed = useQuery({
    queryKey: queryKeys.gitUnpushed(target.cwd),
    queryFn: () => ops.unpushedCount(target.cwd),
    refetchInterval: 5000,
    retry: false,
  })
  return {
    changes: status.data ?? [],
    unpushed: unpushed.data ?? 0,
    ops,
    isLoading: status.isLoading,
    error: status.error,
    refresh: async () => {
      await Promise.all([status.refetch(), unpushed.refetch()])
    },
  }
}
