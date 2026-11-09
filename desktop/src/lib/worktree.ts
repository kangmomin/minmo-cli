// 이슈 열기(openIssue)·worktree 삭제(deleteWorktree) 도메인 서비스.
// Frontend Plan "src/lib/worktree.ts" 규칙을 따른다. 모든 OS 접근은 TauriApi 경유.
import type { Effective, Platform } from '@minmo/api-client'

import type { TauriApi } from './tauri'

export type IssueTarget = {
  owner: string
  repo: string
  /** 이슈 번호 문자열 또는 'etc' */
  key: string
  /** 기타 이슈는 null */
  number: number | null
  title: string
}

export type WorktreeEntry = { path: string; branch: string }

export interface WorktreePathStore {
  get(id: string): WorktreeEntry | undefined
  set(id: string, entry: WorktreeEntry): void
  delete(id: string): void
}

export type SetupStep = 'effective' | 'clone' | 'fetch' | 'prune' | 'branch' | 'worktree' | 'script'
export type SetupLogEvent = {
  issueId: string
  step: SetupStep
  status: 'start' | 'ok' | 'error' | 'cancelled' | 'log'
  /** git·스크립트 stderr 전문 등 */
  message?: string
}

export type WorktreeErrorCode =
  | 'main_not_repo'
  | 'path_exists_unregistered'
  | 'overlaps_main_clone'
  | 'branch_conflicts_etc'
  | 'git_failed'
  | 'server_required'
  | 'etc_not_deletable'
  | 'not_found'

export class WorktreeError extends Error {
  code: WorktreeErrorCode
  path?: string
  stderr?: string
  constructor(code: WorktreeErrorCode, init?: { message?: string; path?: string; stderr?: string }) {
    super(init?.message ?? code)
    this.name = 'WorktreeError'
    this.code = code
    if (init?.path !== undefined) this.path = init.path
    if (init?.stderr !== undefined) this.stderr = init.stderr
  }
}

export type ScriptOutcome = { status: 'skipped' | 'succeeded' | 'failed' | 'cancelled'; exitCode: number | null }

export type OpenIssueResult = {
  issueId: string
  path: string
  branch: string
  /** 이번 호출에서 worktree 를 새로 만들었는가 (AC-06 전환이면 false) */
  created: boolean
  /** EC-24: 기존 worktree 경로가 현재 effective 로 계산한 경로와 다름 */
  pathChanged: boolean
  script: ScriptOutcome
}

export type DeleteCheck = { uncommitted: number; unpushed: number }
export type DeleteResult = { status: 'deleted' } | ({ status: 'needs_confirmation' } & DeleteCheck)

export interface WorktreeDeps {
  tauri: TauriApi
  getEffective(owner: string, repo: string): Promise<Effective>
  defaultBranch(owner: string, repo: string): Promise<string>
  pathStore: WorktreePathStore
  home: string
  platform: Platform
  onLog?(e: SetupLogEvent): void
  newRunId?(): string
}

export interface WorktreeService {
  openIssue(t: IssueTarget): Promise<OpenIssueResult>
  /** 진행 중인 생성 후 스크립트 취소 (EC-21) */
  cancelSetup(t: IssueTarget): Promise<void>
  /** [다시 실행] — 수동 재실행 */
  rerunScript(t: IssueTarget): Promise<ScriptOutcome>
  inspect(t: IssueTarget): Promise<DeleteCheck>
  deleteWorktree(t: IssueTarget, opts?: { confirmed?: boolean }): Promise<DeleteResult>
}

/** worktreePathMap 키 */
export function worktreeId(owner: string, repo: string, key: string): string {
  return `${owner}/${repo}#${key}`
}

// STUB (Phase 6.1 Red)
export function createWorktreeService(_deps: WorktreeDeps): WorktreeService {
  const notImplemented = async (): Promise<never> => {
    throw new Error('not implemented')
  }
  return {
    openIssue: notImplemented,
    cancelSetup: notImplemented,
    rerunScript: notImplemented,
    inspect: notImplemented,
    deleteWorktree: notImplemented,
  }
}
