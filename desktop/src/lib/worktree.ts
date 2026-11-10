// 이슈 열기(openIssue)·worktree 삭제(deleteWorktree) 도메인 서비스.
// Frontend Plan "src/lib/worktree.ts" 규칙을 따른다. 모든 OS 접근은 TauriApi 경유.
import { TemplateError, isSameOrInside, normalizePath, renderBranch, renderPath, slug as slugOf } from '@minmo/api-client'
import type { Effective, PathContext, Platform, SettingsValues } from '@minmo/api-client'

import { isOfflineError } from './apiErrors'
import type { CmdResult, ScriptRunResult, TauriApi } from './tauri'

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

/**
 * 이슈의 브랜치명 + 경로 템플릿 컨텍스트. openIssue·트리 "경로 변경됨" 배지(EC-24)·설정 미리보기가
 * 같은 규칙으로 계산해야 서로 어긋나지 않는다. checkEtcConflict 면 기타 브랜치와 충돌 시 TemplateError.
 */
export function issueBranchContext(
  values: Pick<SettingsValues, 'branchTemplate' | 'etcBranchName'>,
  t: IssueTarget,
  env: { home: string; platform: Platform },
  opts: { checkEtcConflict: boolean },
): { branch: string; ctx: PathContext } {
  const branch =
    t.number === null
      ? values.etcBranchName
      : renderBranch(
          values.branchTemplate,
          { number: t.number, title: t.title },
          opts.checkEtcConflict ? { etcBranchName: values.etcBranchName } : undefined,
        )
  const ctx: PathContext = {
    owner: t.owner,
    repo: t.repo,
    branch,
    key: t.key,
    number: t.number,
    slug: t.number === null ? '' : slugOf(t.title),
    home: env.home,
    platform: env.platform,
  }
  return { branch, ctx }
}

/** origin 어느 브랜치에도 없는 HEAD 커밋 수. git 실패 시 null(개수 불명) */
async function tryCountUnpushed(gitRun: TauriApi['gitRun'], cwd: string): Promise<number | null> {
  const r = await gitRun(['-C', cwd, 'rev-list', '--count', 'HEAD', '--not', '--remotes=origin'])
  if (r.code !== 0) return null
  const n = Number.parseInt(r.stdout.trim(), 10)
  return Number.isNaN(n) ? null : n
}

/** 변경 탭 "미push" 표시용. 실패 시 0 — 삭제 판단에는 쓰지 않는다(inspect 는 실패를 null 로 구분) */
export async function countUnpushed(gitRun: TauriApi['gitRun'], cwd: string): Promise<number> {
  return (await tryCountUnpushed(gitRun, cwd)) ?? 0
}

export interface WorktreePathStore {
  get(id: string): WorktreeEntry | undefined
  set(id: string, entry: WorktreeEntry): void
  delete(id: string): void
}

export type SetupStep = 'effective' | 'clone' | 'fetch' | 'prune' | 'branch' | 'worktree' | 'sparse' | 'localfiles' | 'script'
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

/** 삭제 전 검사. null = git 실패로 개수 불명 → 데이터 손실 방지를 위해 확인을 요구한다(EC-15) */
export type DeleteCheck = { uncommitted: number | null; unpushed: number | null }
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
  /** 이 저장소의 로컬 파일 보관 폴더 — worktree 가 있으면 그 메인 clone 기준(설정 변경과 무관) */
  localFilesDirFor(t: IssueTarget): Promise<string>
}

/** 미커밋·미push 가 있거나 개수를 확인하지 못했으면 사용자 확인이 필요하다 */
export function needsConfirmation(c: DeleteCheck): boolean {
  return c.uncommitted === null || c.unpushed === null || c.uncommitted > 0 || c.unpushed > 0
}

/** 레포별 로컬 파일 보관 폴더: 메인 clone 의 형제 `_local` (기본 ~/minmo-workspaces/{owner}/{repo}/_local) */
export function localFilesDir(main: string, platform: Platform): string {
  // normalizePath 는 Windows 에서 소문자로 바꾸므로(비교용) 표시·생성용 경로는 구분자만 맞춘다
  const sep = platform === 'win32' ? '\\' : '/'
  const n = main.replace(/[\\/]+/g, sep).replace(/[\\/]+$/, '')
  const i = n.lastIndexOf(sep)
  return `${i > 0 ? n.slice(0, i) : n}${sep}_local`
}

/** sparsePaths 설정 → cone 디렉터리 목록(빈 줄·앞뒤 공백·끝 / 제거). 빈 목록 = 전체 체크아웃 */
export function sparseDirs(v: string): string[] {
  return v
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

/** worktreePathMap 키 */
export function worktreeId(owner: string, repo: string, key: string): string {
  return `${owner}/${repo}#${key}`
}


type Plan = {
  issueId: string
  values: SettingsValues
  branch: string
  /** 현재 effective 로 계산한 worktree 경로 */
  path: string
  main: string
  /** 로컬 파일 보관 폴더 */
  local: string
}

type RunningScript = { runId: string; done: Promise<ScriptRunResult> }

const SKIPPED: ScriptOutcome = { status: 'skipped', exitCode: null }

const cloneUrl = (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`

/** `git worktree list --porcelain` → path 가 등록돼 있으면 브랜치명(분리 HEAD 는 ''), 아니면 undefined */
function findRegistered(stdout: string, path: string, platform: Platform): string | undefined {
  const target = normalizePath(path, platform)
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const wt = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
    if (!wt || normalizePath(wt, platform) !== target) continue
    const br = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? ''
    return br.replace(/^refs\/heads\//, '')
  }
  return undefined
}

export function createWorktreeService(deps: WorktreeDeps): WorktreeService {
  const { tauri, platform } = deps
  /** 이슈별 in-flight 중복 제거 */
  const inflight = new Map<string, Promise<OpenIssueResult>>()
  /** 저장소별 mutex (git 조작 구간만) */
  const repoLocks = new Map<string, Promise<void>>()
  /** 이슈별 실행 중인 생성 후 스크립트 */
  const running = new Map<string, RunningScript>()
  let seq = 0
  const newRunId = deps.newRunId ?? (() => globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${++seq}`)

  const log = (issueId: string, step: SetupStep, status: SetupLogEvent['status'], message?: string) =>
    deps.onLog?.({ issueId, step, status, ...(message !== undefined ? { message } : {}) })

  async function withRepoLock<T>(owner: string, repo: string, fn: () => Promise<T>): Promise<T> {
    const key = `${owner}/${repo}`.toLowerCase()
    const prev = repoLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((r) => (release = r))
    const tail = prev.then(() => mine)
    repoLocks.set(key, tail)
    await prev
    try {
      return await fn()
    } finally {
      release()
      if (repoLocks.get(key) === tail) repoLocks.delete(key)
    }
  }

  async function gitOrThrow(issueId: string, step: SetupStep, args: string[]): Promise<CmdResult> {
    const res = await tauri.gitRun(args)
    if (res.code !== 0) {
      const stderr = res.stderr.trim()
      log(issueId, step, 'error', stderr || `git ${args.join(' ')} 실패(${res.code})`)
      throw new WorktreeError('git_failed', { message: stderr || `git 실패(${res.code})`, stderr: res.stderr })
    }
    return res
  }

  async function loadEffective(owner: string, repo: string): Promise<Effective> {
    try {
      return await deps.getEffective(owner, repo)
    } catch (e) {
      // EC-17: 캐시도 없이 서버에 닿지 못하면 이슈를 열 수 없다
      if (isOfflineError(e)) {
        throw new WorktreeError('server_required', { message: '서버 연결 필요 — 설정을 불러올 수 없습니다' })
      }
      throw e
    }
  }

  async function plan(t: IssueTarget): Promise<Plan> {
    const issueId = worktreeId(t.owner, t.repo, t.key)
    log(issueId, 'effective', 'start')
    const values = (await loadEffective(t.owner, t.repo)).values
    let resolved: { branch: string; ctx: PathContext }
    try {
      resolved = issueBranchContext(values, t, { home: deps.home, platform }, { checkEtcConflict: true })
    } catch (e) {
      if (e instanceof TemplateError) {
        log(issueId, 'effective', 'error', '브랜치명이 기타 브랜치와 충돌')
        throw new WorktreeError('branch_conflicts_etc', { message: '브랜치명이 기타 브랜치와 충돌합니다' })
      }
      throw e
    }
    const { branch, ctx } = resolved
    const main = renderPath(values.mainClonePath, ctx)
    const path = renderPath(values.worktreePath, ctx)
    // EC-23: worktree 가 메인 clone 과 같거나 그 하위면 중단
    if (isSameOrInside(path, main, platform)) {
      log(issueId, 'effective', 'error', `worktree 경로가 메인 clone 과 겹칩니다: ${path}`)
      throw new WorktreeError('overlaps_main_clone', { path, message: 'worktree 경로가 메인 clone 경로와 겹칩니다' })
    }
    const local = localFilesDir(main, platform)
    if (isSameOrInside(path, local, platform)) {
      log(issueId, 'effective', 'error', `worktree 경로가 로컬 파일 보관 폴더와 겹칩니다: ${path}`)
      throw new WorktreeError('overlaps_main_clone', { path, message: 'worktree 경로가 로컬 파일 보관 폴더(_local)와 겹칩니다' })
    }
    log(issueId, 'effective', 'ok')
    return { issueId, values, branch, path, main, local }
  }

  async function resolveDefaultBranch(t: IssueTarget, main: string): Promise<string> {
    try {
      return await deps.defaultBranch(t.owner, t.repo)
    } catch {
      // GitHub 조회 실패 시 로컬 origin/HEAD 로 추정
      const r = await tauri.gitRun(['-C', main, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      const b = r.code === 0 ? r.stdout.trim().replace(/^origin\//, '') : ''
      return b || 'main'
    }
  }

  async function runScript(
    issueId: string,
    t: IssueTarget,
    where: { cwd: string; branch: string; main: string; defaultBranch: string },
    script: string,
  ): Promise<ScriptOutcome> {
    if (script.trim() === '') return SKIPPED
    const runId = newRunId()
    log(issueId, 'script', 'start')
    const unlisten = await tauri.onScriptLog((e) => {
      if (e.runId === runId) log(issueId, 'script', 'log', e.line)
    })
    const env: Record<string, string> = {
      MINMO_OWNER: t.owner,
      MINMO_REPO: t.repo,
      MINMO_BRANCH: where.branch,
      MINMO_ISSUE_KEY: t.key,
      MINMO_ISSUE_NUMBER: t.number === null ? '' : String(t.number),
      MINMO_WORKTREE: where.cwd,
      MINMO_MAIN_CLONE: where.main,
      MINMO_DEFAULT_BRANCH: where.defaultBranch,
    }
    const done = tauri.scriptRun({ runId, cwd: where.cwd, script, env })
    running.set(issueId, { runId, done })
    try {
      const r = await done
      if (r.cancelled) {
        log(issueId, 'script', 'cancelled')
        return { status: 'cancelled', exitCode: null }
      }
      if (r.exitCode === 0) {
        log(issueId, 'script', 'ok')
        return { status: 'succeeded', exitCode: 0 }
      }
      // EC-19: 실패해도 worktree 는 유지하고 이슈는 열린다
      log(issueId, 'script', 'error', `종료 코드 ${r.exitCode}`)
      return { status: 'failed', exitCode: r.exitCode }
    } catch (e) {
      log(issueId, 'script', 'error', e instanceof Error ? e.message : String(e))
      return { status: 'failed', exitCode: null }
    } finally {
      if (running.get(issueId)?.runId === runId) running.delete(issueId)
      unlisten()
    }
  }

  async function doOpen(t: IssueTarget): Promise<OpenIssueResult> {
    const p = await plan(t)
    const { issueId } = p

    // AC-06 / EC-24: 이미 만든 worktree 는 이동하지 않고 그대로 전환
    const existing = deps.pathStore.get(issueId)
    if (existing && (await tauri.pathExists(existing.path))) {
      return {
        issueId,
        path: existing.path,
        branch: existing.branch,
        created: false,
        pathChanged: normalizePath(existing.path, platform) !== normalizePath(p.path, platform),
        script: SKIPPED,
      }
    }

    let defaultBranch: string | undefined
    // git 조작 구간만 repo mutex 로 직렬화한다. 스크립트 실행 중에는 쥐지 않는다
    // (deleteWorktree 가 스크립트를 먼저 취소한 뒤 mutex 를 잡으므로 교착 방지).
    const outcome = await withRepoLock(t.owner, t.repo, async () => {
      if (await tauri.pathExists(p.main)) {
        const r = await tauri.gitRun(['-C', p.main, 'rev-parse', '--git-dir'])
        if (r.code !== 0) {
          log(issueId, 'clone', 'error', `메인 clone 경로가 git 저장소가 아닙니다: ${p.main}`)
          throw new WorktreeError('main_not_repo', {
            path: p.main,
            stderr: r.stderr,
            message: `메인 clone 경로가 git 저장소가 아닙니다 — 직접 확인 후 정리하세요: ${p.main}`,
          })
        }
      } else {
        log(issueId, 'clone', 'start', p.main)
        // 부분 clone: 파일 내용(blob)은 worktree 가 체크아웃할 때 필요한 것만 받는다.
        // 메인 clone 은 저장소 역할만 하므로(작업은 worktree, etc 포함) 체크아웃하지 않는다
        const r = await tauri.gitRun(['clone', '--filter=blob:none', '--no-checkout', cloneUrl(t.owner, t.repo), p.main])
        // 체크아웃 없는 clone 은 status 에 모든 파일이 삭제로 보여 실수로 커밋하면 전체 삭제가 된다 → bare 로 표시해
        // 작업 트리 명령을 막는다(fetch·worktree·브랜치 조회는 그대로, 기본 브랜치도 worktree 로 열 수 있다)
        const bare = r.code === 0 ? await tauri.gitRun(['-C', p.main, 'config', 'core.bare', 'true']) : r
        if (bare.code !== 0) {
          const failed = r.code !== 0 ? r : bare
          log(issueId, 'clone', 'error', failed.stderr.trim() || `git clone 실패(${failed.code})`)
          // EC-10: 이번 실행이 새로 만든 경로만 정리
          if (await tauri.pathExists(p.main)) await tauri.removeDir(p.main)
          throw new WorktreeError('git_failed', { message: failed.stderr.trim() || 'git clone 실패', stderr: failed.stderr })
        }
        log(issueId, 'clone', 'ok')
      }

      log(issueId, 'fetch', 'start')
      await gitOrThrow(issueId, 'fetch', ['-C', p.main, 'fetch', 'origin', '--prune'])
      log(issueId, 'fetch', 'ok')

      log(issueId, 'prune', 'start')
      await gitOrThrow(issueId, 'prune', ['-C', p.main, 'worktree', 'prune'])
      log(issueId, 'prune', 'ok')

      if (await tauri.pathExists(p.path)) {
        const list = await gitOrThrow(issueId, 'worktree', ['-C', p.main, 'worktree', 'list', '--porcelain'])
        const registered = findRegistered(list.stdout, p.path, platform)
        if (registered === undefined) {
          // EC-09: git 에 등록되지 않은 기존 경로 — 아무것도 지우지 않고 중단
          log(issueId, 'worktree', 'error', `경로가 이미 있지만 git worktree 가 아닙니다: ${p.path}`)
          throw new WorktreeError('path_exists_unregistered', {
            path: p.path,
            message: `경로가 이미 있지만 git worktree 가 아닙니다: ${p.path}`,
          })
        }
        const branch = registered || p.branch
        deps.pathStore.set(issueId, { path: p.path, branch })
        return { created: false, branch }
      }

      // 브랜치 결정: 로컬 재사용 → 원격 추적 → default_branch 에서 생성
      log(issueId, 'branch', 'start', p.branch)
      const b = p.branch
      const hasLocal = (await tauri.gitRun(['-C', p.main, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`])).code === 0
      let addArgs: string[]
      if (hasLocal) {
        addArgs = ['worktree', 'add', p.path, b]
      } else {
        const hasRemote =
          (await tauri.gitRun(['-C', p.main, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`])).code === 0
        if (hasRemote) {
          // EC-08: 원격 브랜치를 새로 만들지 않고 추적
          addArgs = ['worktree', 'add', '--track', '-b', b, p.path, `origin/${b}`]
        } else {
          defaultBranch = await resolveDefaultBranch(t, p.main)
          // upstream 이 default 브랜치로 잡히지 않도록 --no-track (push -u 에서 설정)
          addArgs = ['worktree', 'add', '--no-track', '-b', b, p.path, `origin/${defaultBranch}`]
        }
      }
      log(issueId, 'branch', 'ok', b)

      // sparse: 체크아웃 없이 만든 뒤 지정 폴더만 체크아웃한다(부분 clone 이라 그 폴더의 blob 만 받는다)
      const dirs = sparseDirs(p.values.sparsePaths)
      if (dirs.length > 0) addArgs.splice(2, 0, '--no-checkout')

      log(issueId, 'worktree', 'start', p.path)
      const add = await tauri.gitRun(['-C', p.main, ...addArgs])
      if (add.code !== 0) {
        log(issueId, 'worktree', 'error', add.stderr.trim() || `git worktree add 실패(${add.code})`)
        if (await tauri.pathExists(p.path)) await tauri.removeDir(p.path)
        throw new WorktreeError('git_failed', { message: add.stderr.trim() || 'git worktree add 실패', stderr: add.stderr })
      }
      log(issueId, 'worktree', 'ok', p.path)

      if (dirs.length > 0) {
        log(issueId, 'sparse', 'start', dirs.join(', '))
        try {
          await gitOrThrow(issueId, 'sparse', ['-C', p.path, 'sparse-checkout', 'set', '--cone', '--end-of-options', ...dirs])
          await gitOrThrow(issueId, 'sparse', ['-C', p.path, 'read-tree', '-mu', 'HEAD'])
        } catch (e) {
          // 체크아웃이 비어 있는 worktree 를 남기지 않는다(브랜치는 남겨 다음 열기에서 재사용)
          await tauri.gitRun(['-C', p.main, 'worktree', 'remove', '--force', p.path])
          if (await tauri.pathExists(p.path)) await tauri.removeDir(p.path)
          throw e
        }
        log(issueId, 'sparse', 'ok')
      }
      deps.pathStore.set(issueId, { path: p.path, branch: b })
      return { created: true, branch: b }
    })

    if (!outcome.created) {
      return { issueId, path: p.path, branch: outcome.branch, created: false, pathChanged: false, script: SKIPPED }
    }

    // 보관해 둔 로컬 파일(.env 등)을 스크립트보다 먼저 넣는다 — 스크립트가 그 값을 쓸 수 있게
    try {
      const n = await tauri.copyTree(p.local, p.path)
      if (n > 0) log(issueId, 'localfiles', 'ok', `로컬 파일 ${n}개 복사`)
    } catch (e) {
      // 복사 실패로 이슈 열기를 막지는 않는다
      log(issueId, 'localfiles', 'error', e instanceof Error ? e.message : String(e))
    }

    // A-14: 생성 후 스크립트는 worktree 를 새로 만들었을 때 1회만
    let script = SKIPPED
    if (p.values.postCreateScript.trim() !== '') {
      defaultBranch ??= await resolveDefaultBranch(t, p.main)
      script = await runScript(issueId, t, { cwd: p.path, branch: outcome.branch, main: p.main, defaultBranch }, p.values.postCreateScript)
    }
    return { issueId, path: p.path, branch: outcome.branch, created: true, pathChanged: false, script }
  }

  async function mainCloneFor(t: IssueTarget, worktreePath: string): Promise<string> {
    // 생성 당시의 메인 clone 을 git 에서 직접 찾는다(설정이 바뀌었어도 정확). 실패하면 현재 설정으로 계산
    const r = await tauri.gitRun(['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const out = r.code === 0 ? r.stdout.trim() : ''
    if (/[\\/]\.git$/.test(out)) return out.replace(/[\\/]\.git$/, '')
    return (await plan(t)).main
  }

  async function inspect(t: IssueTarget): Promise<DeleteCheck> {
    const entry = deps.pathStore.get(worktreeId(t.owner, t.repo, t.key))
    if (!entry) throw new WorktreeError('not_found', { message: 'worktree 가 없습니다' })
    // 읽기 전용 git 두 개 — 서로 독립이라 병렬
    const [st, unpushed] = await Promise.all([
      tauri.gitRun(['-C', entry.path, 'status', '--porcelain']),
      tryCountUnpushed(tauri.gitRun, entry.path),
    ])
    // 실패를 0 으로 보면 경고 없이 --force 삭제로 이어진다 → null(불명)로 구분
    const uncommitted = st.code === 0 ? st.stdout.split(/\r?\n/).filter((l) => l.trim() !== '').length : null
    return { uncommitted, unpushed }
  }

  return {
    openIssue(t) {
      const id = worktreeId(t.owner, t.repo, t.key)
      const cur = inflight.get(id)
      if (cur) return cur
      const p = doOpen(t).finally(() => {
        if (inflight.get(id) === p) inflight.delete(id)
      })
      inflight.set(id, p)
      return p
    },

    async cancelSetup(t) {
      const r = running.get(worktreeId(t.owner, t.repo, t.key))
      if (r) await tauri.scriptCancel(r.runId)
    },

    async rerunScript(t) {
      const issueId = worktreeId(t.owner, t.repo, t.key)
      const entry = deps.pathStore.get(issueId)
      if (!entry) throw new WorktreeError('not_found', { message: 'worktree 가 없습니다' })
      const p = await plan(t)
      const defaultBranch = await resolveDefaultBranch(t, p.main)
      return runScript(issueId, t, { cwd: entry.path, branch: entry.branch, main: p.main, defaultBranch }, p.values.postCreateScript)
    },

    inspect,

    async localFilesDirFor(t) {
      const entry = deps.pathStore.get(worktreeId(t.owner, t.repo, t.key))
      const main = entry ? await mainCloneFor(t, entry.path) : (await plan(t)).main
      return localFilesDir(main, platform)
    },

    async deleteWorktree(t, opts) {
      // EC-16: ★기타는 삭제하지 않는다
      if (t.key === 'etc') throw new WorktreeError('etc_not_deletable', { message: '기타 worktree 는 삭제할 수 없습니다' })
      const issueId = worktreeId(t.owner, t.repo, t.key)
      const entry = deps.pathStore.get(issueId)
      if (!entry) throw new WorktreeError('not_found', { message: 'worktree 가 없습니다' })

      if (!opts?.confirmed) {
        const check = await inspect(t)
        if (needsConfirmation(check)) return { status: 'needs_confirmation', ...check }
      }

      // 해당 경로를 cwd 로 쓰는 스크립트·PTY 를 먼저 종료 (Windows 파일 잠금 방지)
      const r = running.get(issueId)
      if (r) {
        await tauri.scriptCancel(r.runId)
        await r.done.catch(() => undefined)
      }
      await tauri.ptyKillByCwd(entry.path)

      await withRepoLock(t.owner, t.repo, async () => {
        const main = await mainCloneFor(t, entry.path)
        const rm = await tauri.gitRun(['-C', main, 'worktree', 'remove', '--force', entry.path])
        if (rm.code !== 0) {
          throw new WorktreeError('git_failed', { message: rm.stderr.trim() || 'git worktree remove 실패', stderr: rm.stderr })
        }
        // 로컬 브랜치 삭제 실패(다른 worktree 가 사용 중 등)는 삭제 자체를 막지 않는다
        await tauri.gitRun(['-C', main, 'branch', '-D', entry.branch])
      })
      deps.pathStore.delete(issueId)
      return { status: 'deleted' }
    },
  }
}
