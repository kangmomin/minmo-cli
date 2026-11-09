// worktree 서비스 (F-03·F-08·F-09) — fake tauri 위의 git 시뮬레이터로 검증
// 근거: AC-05~07, AC-14, AC-16, EC-08~10, EC-15, EC-16, EC-19, EC-21, EC-23, EC-24,
//       Frontend Plan worktree.ts 규칙(로컬 브랜치 재사용·prune·repo mutex·중복 요청·etc 충돌·_main 비repo 중단·PTY 선종료)
import { describe, expect, it, vi } from 'vitest'

import type { Effective, SettingsValues } from '@minmo/api-client'

import { createFakeTauri, deferred, fail, flush, ok } from '../test/fakes'
import type { CmdResult, RunOptions, ScriptRunResult } from './tauri'
import { createWorktreeService, worktreeId } from './worktree'
import type { IssueTarget, SetupLogEvent, WorktreeEntry } from './worktree'

const HOME = '/home/u'
const MAIN = '/home/u/minmo-workspaces/MyOrg/Repo-A/_main'
const WT42 = '/home/u/minmo-workspaces/MyOrg/Repo-A/issue--42-add-login'
const BR42 = 'issue/42-add-login'

const ISSUE42: IssueTarget = { owner: 'MyOrg', repo: 'Repo-A', key: '42', number: 42, title: 'Add login' }
const ISSUE43: IssueTarget = { owner: 'MyOrg', repo: 'Repo-A', key: '43', number: 43, title: 'Fix bug' }
const ETC: IssueTarget = { owner: 'MyOrg', repo: 'Repo-A', key: 'etc', number: null, title: '' }
const ID42 = worktreeId('MyOrg', 'Repo-A', '42')

const DEFAULTS: SettingsValues = {
  branchTemplate: 'issue/{number}-{slug}',
  etcBranchName: 'etc',
  worktreePath: '~/minmo-workspaces/{owner}/{repo}/{branch}',
  mainClonePath: '~/minmo-workspaces/{owner}/{repo}/_main',
  postCreateScript: '',
}

const effective = (v: Partial<SettingsValues> = {}): Effective => ({
  values: { ...DEFAULTS, ...v },
  sources: { branchTemplate: 'global', etcBranchName: 'global', worktreePath: 'global', mainClonePath: 'global', postCreateScript: 'global' },
})

// ── git 시뮬레이터 ───────────────────────────────────────────────
type Sim = {
  existing: Set<string>
  mainIsRepo: boolean
  local: Set<string>
  remote: Set<string>
  worktrees: Map<string, string>
  dirty: string[]
  unpushed: number
  failClone?: string
  failFetch?: string
  failWorktreeAdd?: string
  holdFetch?: Promise<void>
}

const HASH = 'abc1234def5678abc1234def5678abc1234def56'

/** `-C <path>` 를 제거하고 [args, cwd] 반환 */
function normalize(args: string[], opts?: RunOptions): [string[], string | undefined] {
  const a = [...args]
  let cwd = opts?.cwd
  const i = a.indexOf('-C')
  if (i >= 0) {
    cwd = a[i + 1]
    a.splice(i, 2)
  }
  return [a, cwd]
}

function refExists(sim: Sim, a: string[]): boolean | undefined {
  for (const x of a) {
    let m = /^refs\/heads\/(.+)$/.exec(x)
    if (m) return sim.local.has(m[1])
    m = /^refs\/remotes\/origin\/(.+)$/.exec(x)
    if (m) return sim.remote.has(m[1])
    m = /^origin\/(.+)$/.exec(x)
    if (m) return sim.remote.has(m[1])
  }
  return undefined
}

async function simGit(sim: Sim, args: string[], opts?: RunOptions): Promise<CmdResult> {
  const [a, cwd] = normalize(args, opts)
  const positional = (from: number) => a.slice(from).filter((x) => !x.startsWith('-'))
  switch (a[0]) {
    case 'clone': {
      const target = a[a.length - 1]
      sim.existing.add(target) // 실패해도 부분 디렉터리가 남는 상황을 재현
      if (sim.failClone) return fail(sim.failClone, 128)
      if (target === MAIN) sim.mainIsRepo = true
      return ok()
    }
    case 'rev-parse': {
      if (a.includes('--git-dir')) {
        return cwd === MAIN && sim.existing.has(MAIN) && sim.mainIsRepo ? ok('.git\n') : fail('fatal: not a git repository', 128)
      }
      const r = refExists(sim, a)
      if (r !== undefined) return r ? ok(HASH + '\n') : fail('', 1)
      if (a.includes('--verify')) {
        const name = positional(1)[0]
        if (name && name !== 'HEAD') return sim.local.has(name) ? ok(HASH + '\n') : fail('', 1)
      }
      return ok(HASH + '\n')
    }
    case 'show-ref': {
      const r = refExists(sim, a)
      return r ? ok(`${HASH} x\n`) : fail('', 1)
    }
    case 'ls-remote': {
      const pats = positional(1).filter((x) => x !== 'origin')
      const lines = [...sim.remote]
        .filter((b) => pats.length === 0 || pats.some((p) => p === b || p === `refs/heads/${b}`))
        .map((b) => `${HASH}\trefs/heads/${b}`)
      return ok(lines.join('\n'))
    }
    case 'branch': {
      if (a.includes('-d') || a.includes('-D')) {
        for (const b of positional(1)) sim.local.delete(b)
        return ok()
      }
      if (a.includes('--list') || a.includes('-l')) {
        const remote = a.includes('-r')
        const pats = positional(1)
        const src = remote ? [...sim.remote].map((b) => `origin/${b}`) : [...sim.local]
        return ok(src.filter((b) => pats.length === 0 || pats.includes(b)).map((b) => `  ${b}`).join('\n'))
      }
      const [name] = positional(1)
      if (name) sim.local.add(name)
      return ok()
    }
    case 'fetch': {
      if (sim.holdFetch) {
        const h = sim.holdFetch
        sim.holdFetch = undefined
        await h
      }
      return sim.failFetch ? fail(sim.failFetch, 128) : ok()
    }
    case 'worktree': {
      const sub = a[1]
      if (sub === 'prune') return ok()
      if (sub === 'list') {
        const entries: [string, string][] = sim.mainIsRepo && sim.existing.has(MAIN) ? [[MAIN, 'main']] : []
        entries.push(...sim.worktrees.entries())
        return ok(entries.map(([p, b]) => `worktree ${p}\nHEAD ${HASH}\nbranch refs/heads/${b}\n`).join('\n'))
      }
      if (sub === 'add') {
        const rest = a.slice(2)
        let newBranch: string | undefined
        const pos: string[] = []
        for (let i = 0; i < rest.length; i++) {
          const x = rest[i]
          if (x === '-b' || x === '-B') newBranch = rest[++i]
          else if (!x.startsWith('-')) pos.push(x)
        }
        const [path, commitish] = pos
        sim.existing.add(path)
        if (sim.failWorktreeAdd) return fail(sim.failWorktreeAdd, 128)
        const branch = newBranch ?? commitish
        sim.worktrees.set(path, branch)
        if (newBranch) sim.local.add(newBranch)
        return ok()
      }
      if (sub === 'remove') {
        const path = positional(2).at(-1)!
        sim.worktrees.delete(path)
        sim.existing.delete(path)
        return ok()
      }
      return ok()
    }
    case 'status': {
      if (a.some((x) => x === '--porcelain=v2' || x === '--porcelain=2')) {
        return ok(
          sim.dirty.map((l) => (l.startsWith('??') ? `? ${l.slice(3)}` : `1 ${l.slice(0, 2).replace(/ /g, '.')} N... 100644 100644 100644 ${HASH} ${HASH} ${l.slice(3)}`)).join('\n'),
        )
      }
      return ok(sim.dirty.join('\n'))
    }
    case 'rev-list':
      return ok(`${sim.unpushed}\n`)
    default:
      return ok()
  }
}

// ── 조립 ─────────────────────────────────────────────────────────
type SetupOpts = {
  sim?: Partial<Sim>
  mainExists?: boolean
  values?: Partial<SettingsValues>
  home?: string
  platform?: 'linux' | 'win32' | 'darwin'
  scriptRun?: (req: { runId: string; cwd: string; script: string; env: Record<string, string> }) => Promise<ScriptRunResult>
  scriptCancel?: (runId: string) => Promise<void>
  entries?: [string, WorktreeEntry][]
}

function setup(o: SetupOpts = {}) {
  const sim: Sim = {
    existing: new Set(),
    mainIsRepo: false,
    local: new Set(),
    remote: new Set(['main']),
    worktrees: new Map(),
    dirty: [],
    unpushed: 0,
    ...o.sim,
  }
  if (o.mainExists) {
    sim.existing.add(MAIN)
    sim.mainIsRepo = o.sim?.mainIsRepo ?? true
  }
  const fake = createFakeTauri({
    gitRun: (args, opts) => simGit(sim, args, opts),
    pathExists: async (p) => sim.existing.has(p),
    removeDir: async (p) => {
      sim.existing.delete(p)
    },
    ...(o.scriptRun ? { scriptRun: o.scriptRun } : {}),
    ...(o.scriptCancel ? { scriptCancel: o.scriptCancel } : {}),
  })
  const store = new Map<string, WorktreeEntry>(o.entries ?? [])
  const pathStore = {
    get: vi.fn((id: string) => store.get(id)),
    set: vi.fn((id: string, e: WorktreeEntry) => {
      store.set(id, e)
    }),
    delete: vi.fn((id: string) => {
      store.delete(id)
    }),
  }
  const getEffective = vi.fn(async (_o: string, _r: string) => effective(o.values))
  const defaultBranch = vi.fn(async (_o: string, _r: string) => 'main')
  const logs: SetupLogEvent[] = []
  let n = 0
  const svc = createWorktreeService({
    tauri: fake.tauri,
    getEffective,
    defaultBranch,
    pathStore,
    home: o.home ?? HOME,
    platform: o.platform ?? 'linux',
    onLog: (e) => logs.push(e),
    newRunId: () => `run-${++n}`,
  })
  const tauri = fake.tauri
  const cmds = () => tauri.gitRun.mock.calls.map(([args, opts]) => normalize(args, opts)[0])
  const find = (pred: (a: string[]) => boolean) => cmds().filter(pred)
  const isAdd = (a: string[]) => a[0] === 'worktree' && a[1] === 'add'
  const isRemove = (a: string[]) => a[0] === 'worktree' && a[1] === 'remove'
  const indexOf = (pred: (a: string[]) => boolean) => cmds().findIndex(pred)
  /** gitRun 호출 중 pred 를 만족하는 첫 호출의 전역 호출 순서 */
  const callOrder = (pred: (a: string[]) => boolean) => {
    const i = indexOf(pred)
    return i < 0 ? Infinity : tauri.gitRun.mock.invocationCallOrder[i]
  }
  /** 브랜치 b 를 새로 만든 호출의 시작점 (worktree add -b / branch b <start>) */
  const creation = (b: string): { start?: string } | null => {
    for (const a of cmds()) {
      if (isAdd(a)) {
        const i = a.findIndex((x) => x === '-b' || x === '-B')
        if (i >= 0 && a[i + 1] === b) {
          const pos = a.slice(2).filter((x, j, arr) => !x.startsWith('-') && arr[j - 1] !== '-b' && arr[j - 1] !== '-B')
          return { start: pos[1] }
        }
      }
      if (a[0] === 'branch' && !a.some((x) => ['-d', '-D', '--list', '-l'].includes(x))) {
        const pos = a.slice(1).filter((x) => !x.startsWith('-'))
        if (pos[0] === b) return { start: pos[1] }
      }
    }
    return null
  }
  return { sim, tauri, svc, store, pathStore, getEffective, defaultBranch, logs, cmds, find, isAdd, isRemove, indexOf, callOrder, creation }
}

// ── 이슈 열기 ────────────────────────────────────────────────────
describe('openIssue — AC-05 전역 기본 설정, 미clone 저장소', () => {
  it('_main clone → 브랜치 issue/42-add-login 생성(default_branch 기준) → worktree issue--42-add-login', async () => {
    const t = setup()
    const res = await t.svc.openIssue(ISSUE42)

    expect(t.getEffective).toHaveBeenCalledWith('MyOrg', 'Repo-A')
    const clone = t.find((a) => a[0] === 'clone')
    expect(clone).toHaveLength(1)
    expect(clone[0].at(-1)).toBe(MAIN)

    const adds = t.find(t.isAdd)
    expect(adds).toHaveLength(1)
    expect(adds[0]).toContain(WT42)
    expect(t.creation(BR42)?.start).toMatch(/^(origin\/)?main$/)

    expect(res).toMatchObject({ issueId: ID42, path: WT42, branch: BR42, created: true, pathChanged: false })
    expect(res.script.status).toBe('skipped')
    expect(t.tauri.scriptRun).not.toHaveBeenCalled()
    expect(t.pathStore.set).toHaveBeenCalledWith(ID42, { path: WT42, branch: BR42 })
  })

  it('순서: clone → fetch → worktree prune → worktree add', async () => {
    const t = setup()
    await t.svc.openIssue(ISSUE42)
    const iClone = t.indexOf((a) => a[0] === 'clone')
    const iFetch = t.indexOf((a) => a[0] === 'fetch')
    const iPrune = t.indexOf((a) => a[0] === 'worktree' && a[1] === 'prune')
    const iAdd = t.indexOf(t.isAdd)
    expect(iClone).toBeGreaterThanOrEqual(0)
    expect(iClone).toBeLessThan(iFetch)
    expect(iFetch).toBeLessThan(iPrune)
    expect(iPrune).toBeLessThan(iAdd)
  })

  it('setup 로그에 단계 이벤트를 남긴다', async () => {
    const t = setup()
    await t.svc.openIssue(ISSUE42)
    const steps = new Set(t.logs.map((l) => l.step))
    expect(steps).toContain('clone')
    expect(steps).toContain('worktree')
    expect(t.logs.every((l) => l.issueId === ID42)).toBe(true)
  })
})

describe('openIssue — 브랜치 결정 (로컬 → 원격 추적 → default_branch)', () => {
  it('EC-08 원격에 같은 브랜치 있으면 새로 만들지 않고 origin/<branch> 를 추적', async () => {
    const t = setup({ mainExists: true, sim: { remote: new Set(['main', BR42]) } })
    await t.svc.openIssue(ISSUE42)
    expect(t.find((a) => a[0] === 'clone')).toHaveLength(0)
    expect(t.creation(BR42)?.start).toMatch(new RegExp(`^(refs/remotes/)?origin/${BR42}$`))
    expect(t.find(t.isAdd)[0]).toContain(WT42)
  })

  it('로컬 브랜치가 있으면(원격에도 있어도) 재사용 — 새 브랜치 생성 없음', async () => {
    const t = setup({ mainExists: true, sim: { local: new Set([BR42]), remote: new Set(['main', BR42]) } })
    const res = await t.svc.openIssue(ISSUE42)
    expect(t.creation(BR42)).toBeNull()
    const add = t.find(t.isAdd)[0]
    expect(add).toContain(WT42)
    expect(add).toContain(BR42)
    expect(res.branch).toBe(BR42)
  })

  it('etc 브랜치 충돌: 렌더 결과가 etcBranchName 과 같으면 열기 중단', async () => {
    const t = setup({ mainExists: true, values: { branchTemplate: 'feat/{number}', etcBranchName: 'feat/42' } })
    await expect(t.svc.openIssue(ISSUE42)).rejects.toMatchObject({ code: 'branch_conflicts_etc' })
    expect(t.find(t.isAdd)).toHaveLength(0)
  })

  it('AC-13 연계: effective branchTemplate feat/{number} → 브랜치 feat/42', async () => {
    const t = setup({ mainExists: true, values: { branchTemplate: 'feat/{number}' } })
    const res = await t.svc.openIssue(ISSUE42)
    expect(res.branch).toBe('feat/42')
    expect(res.path).toBe('/home/u/minmo-workspaces/MyOrg/Repo-A/feat--42')
  })
})

describe('openIssue — AC-06 기존 worktree 전환 / EC-24 경로 변경', () => {
  it('AC-06 이미 worktree 가 있으면 생성·스크립트 없이 전환', async () => {
    const t = setup({
      mainExists: true,
      values: { postCreateScript: 'npm ci' },
      sim: { worktrees: new Map([[WT42, BR42]]), local: new Set([BR42]) },
      entries: [[ID42, { path: WT42, branch: BR42 }]],
    })
    t.sim.existing.add(WT42)
    const res = await t.svc.openIssue(ISSUE42)
    expect(res).toMatchObject({ path: WT42, branch: BR42, created: false, pathChanged: false })
    expect(res.script.status).toBe('skipped')
    expect(t.find(t.isAdd)).toHaveLength(0)
    expect(t.find((a) => a[0] === 'clone')).toHaveLength(0)
    expect(t.tauri.scriptRun).not.toHaveBeenCalled()
  })

  it('EC-24 설정 경로가 바뀌어도 기존 worktree 는 이동하지 않고 "경로 변경됨" 표시', async () => {
    const OLD = '/home/u/old-place/MyOrg/Repo-A/issue--42-add-login'
    const t = setup({
      mainExists: true,
      sim: { worktrees: new Map([[OLD, BR42]]), local: new Set([BR42]) },
      entries: [[ID42, { path: OLD, branch: BR42 }]],
    })
    t.sim.existing.add(OLD)
    const res = await t.svc.openIssue(ISSUE42)
    expect(res).toMatchObject({ path: OLD, created: false, pathChanged: true })
    expect(t.find(t.isAdd)).toHaveLength(0)
    expect(t.find(t.isRemove)).toHaveLength(0)
  })
})

describe('openIssue — AC-07 ★기타', () => {
  it('브랜치 = etcBranchName, 경로 {branch}=etc', async () => {
    const t = setup({ mainExists: true })
    const res = await t.svc.openIssue(ETC)
    expect(res.branch).toBe('etc')
    expect(res.path).toBe('/home/u/minmo-workspaces/MyOrg/Repo-A/etc')
    expect(t.find(t.isAdd)[0]).toContain('/home/u/minmo-workspaces/MyOrg/Repo-A/etc')
    expect(t.pathStore.set).toHaveBeenCalledWith(worktreeId('MyOrg', 'Repo-A', 'etc'), { path: res.path, branch: 'etc' })
  })

  it('etcBranchName 설정값을 따른다', async () => {
    const t = setup({ mainExists: true, values: { etcBranchName: 'scratch' } })
    const res = await t.svc.openIssue(ETC)
    expect(res.branch).toBe('scratch')
  })
})

describe('openIssue — 중단 조건', () => {
  it('EC-09 경로가 이미 있지만 git 에 등록되지 않음 → 생성 중단, 경로 표시, 아무것도 지우지 않음', async () => {
    const t = setup({ mainExists: true })
    t.sim.existing.add(WT42)
    await expect(t.svc.openIssue(ISSUE42)).rejects.toMatchObject({ code: 'path_exists_unregistered', path: WT42 })
    expect(t.find(t.isAdd)).toHaveLength(0)
    expect(t.tauri.removeDir).not.toHaveBeenCalled()
    expect(t.sim.existing.has(WT42)).toBe(true)
  })

  it('_main 경로가 있는데 git repo 가 아님 → 삭제 없이 중단·안내 (clone 하지 않음)', async () => {
    const t = setup({ mainExists: true, sim: { mainIsRepo: false } })
    await expect(t.svc.openIssue(ISSUE42)).rejects.toMatchObject({ code: 'main_not_repo' })
    expect(t.find((a) => a[0] === 'clone')).toHaveLength(0)
    expect(t.find(t.isAdd)).toHaveLength(0)
    expect(t.tauri.removeDir).not.toHaveBeenCalled()
  })

  it('EC-23 해석된 worktree 경로가 메인 clone 하위(Windows 대소문자 무시) → 중단', async () => {
    const t = setup({
      home: 'C:\\Users\\X',
      platform: 'win32',
      values: { mainClonePath: '~/ws/{owner}/{repo}/_main', worktreePath: '~/WS/{owner}/{repo}/_MAIN/{key}' },
    })
    await expect(t.svc.openIssue(ISSUE42)).rejects.toMatchObject({ code: 'overlaps_main_clone' })
    expect(t.find((a) => a[0] === 'clone')).toHaveLength(0)
    expect(t.find(t.isAdd)).toHaveLength(0)
  })

  it('EC-23 worktree 경로 == 메인 clone 경로 → 중단', async () => {
    const t = setup({ values: { worktreePath: '~/minmo-workspaces/{owner}/{repo}/_main', mainClonePath: '~/minmo-workspaces/{owner}/{repo}/_main' } })
    await expect(t.svc.openIssue(ISSUE42)).rejects.toMatchObject({ code: 'overlaps_main_clone' })
    expect(t.find(t.isAdd)).toHaveLength(0)
  })
})

describe('openIssue — EC-10 부분 실패 정리: 이번 실행이 새로 만든 경로만', () => {
  it('clone 네트워크 실패 → stderr 로그, 새로 만든 _main 정리, worktree·스크립트 없음', async () => {
    const stderr = "fatal: unable to access 'https://github.com/MyOrg/Repo-A.git/': Could not resolve host: github.com"
    const t = setup({ sim: { failClone: stderr }, values: { postCreateScript: 'npm ci' } })
    await expect(t.svc.openIssue(ISSUE42)).rejects.toMatchObject({ code: 'git_failed' })
    expect(t.logs.some((l) => l.status === 'error' && (l.message ?? '').includes('Could not resolve host'))).toBe(true)
    expect(t.tauri.removeDir).toHaveBeenCalledWith(MAIN)
    expect(t.find(t.isAdd)).toHaveLength(0)
    expect(t.tauri.scriptRun).not.toHaveBeenCalled()
    expect(t.pathStore.set).not.toHaveBeenCalled()
  })

  it('기존 _main 에서 fetch 실패 → 기존 경로는 지우지 않음', async () => {
    const t = setup({ mainExists: true, sim: { failFetch: 'fatal: unable to access: Could not resolve host' } })
    await expect(t.svc.openIssue(ISSUE42)).rejects.toMatchObject({ code: 'git_failed' })
    expect(t.tauri.removeDir).not.toHaveBeenCalled()
    expect(t.sim.existing.has(MAIN)).toBe(true)
    expect(t.find(t.isAdd)).toHaveLength(0)
  })

  it('worktree add 실패 → 남은 worktree 디렉터리만 정리, 기존 _main 은 보존', async () => {
    const t = setup({ mainExists: true, sim: { failWorktreeAdd: 'fatal: could not create leading directories' }, values: { postCreateScript: 'npm ci' } })
    await expect(t.svc.openIssue(ISSUE42)).rejects.toMatchObject({ code: 'git_failed' })
    expect(t.tauri.removeDir).toHaveBeenCalledWith(WT42)
    expect(t.tauri.removeDir).not.toHaveBeenCalledWith(MAIN)
    expect(t.tauri.scriptRun).not.toHaveBeenCalled()
    expect(t.pathStore.set).not.toHaveBeenCalled()
  })
})

describe('openIssue — 동시성 (repo mutex · 이슈별 중복 제거)', () => {
  it('같은 이슈 동시 요청 → 한 번만 생성하고 같은 결과', async () => {
    const t = setup({ mainExists: true })
    const [a, b] = await Promise.all([t.svc.openIssue(ISSUE42), t.svc.openIssue(ISSUE42)])
    expect(a).toEqual(b)
    expect(t.find(t.isAdd)).toHaveLength(1)
    expect(t.getEffective).toHaveBeenCalledTimes(1)
  })

  it('같은 저장소의 다른 이슈는 직렬화 — 앞 작업의 git 이 끝나기 전 다음 이슈는 fetch 하지 않음', async () => {
    const hold = deferred<void>()
    const t = setup({ mainExists: true, sim: { holdFetch: hold.promise } })
    const p1 = t.svc.openIssue(ISSUE42)
    const p2 = t.svc.openIssue(ISSUE43)
    await flush(10)
    expect(t.find((a) => a[0] === 'fetch')).toHaveLength(1)
    expect(t.find(t.isAdd)).toHaveLength(0)
    hold.resolve()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.branch).toBe(BR42)
    expect(r2.branch).toBe('issue/43-fix-bug')
    expect(t.find(t.isAdd)).toHaveLength(2)
  })
})

describe('openIssue — 생성 후 스크립트 (AC-16, EC-19, EC-21)', () => {
  it('AC-16 worktree add 뒤 worktree cwd 에서 1회 실행, MINMO_* env 주입, 성공 → succeeded', async () => {
    const t = setup({ mainExists: true, values: { postCreateScript: 'npm ci' } })
    const res = await t.svc.openIssue(ISSUE42)
    expect(t.tauri.scriptRun).toHaveBeenCalledTimes(1)
    expect(t.tauri.scriptRun.mock.calls[0][0]).toMatchObject({
      cwd: WT42,
      script: 'npm ci',
      env: expect.objectContaining({
        MINMO_OWNER: 'MyOrg',
        MINMO_REPO: 'Repo-A',
        MINMO_BRANCH: BR42,
        MINMO_ISSUE_KEY: '42',
        MINMO_ISSUE_NUMBER: '42',
        MINMO_WORKTREE: WT42,
        MINMO_MAIN_CLONE: MAIN,
        MINMO_DEFAULT_BRANCH: 'main',
      }),
    })
    expect(t.tauri.scriptRun.mock.invocationCallOrder[0]).toBeGreaterThan(t.callOrder(t.isAdd))
    expect(res.script).toEqual({ status: 'succeeded', exitCode: 0 })
  })

  it('EC-19 종료 코드 ≠ 0 → worktree 유지, failed + exitCode, 이슈는 열림', async () => {
    const t = setup({ mainExists: true, values: { postCreateScript: 'exit 3' }, scriptRun: async () => ({ exitCode: 3, cancelled: false }) })
    const res = await t.svc.openIssue(ISSUE42)
    expect(res).toMatchObject({ path: WT42, created: true, script: { status: 'failed', exitCode: 3 } })
    expect(t.find(t.isRemove)).toHaveLength(0)
    expect(t.tauri.removeDir).not.toHaveBeenCalled()
    expect(t.pathStore.set).toHaveBeenCalledWith(ID42, { path: WT42, branch: BR42 })
  })

  it('EC-21 실행 중 취소 → scriptCancel(runId), cancelled, worktree 유지', async () => {
    const run = deferred<ScriptRunResult>()
    const t = setup({
      mainExists: true,
      values: { postCreateScript: 'sleep 100' },
      scriptRun: () => run.promise,
      scriptCancel: async () => run.resolve({ exitCode: null, cancelled: true }),
    })
    const p = t.svc.openIssue(ISSUE42)
    await vi.waitFor(() => expect(t.tauri.scriptRun).toHaveBeenCalled())
    await t.svc.cancelSetup(ISSUE42)
    const res = await p
    expect(t.tauri.scriptCancel).toHaveBeenCalledWith(t.tauri.scriptRun.mock.calls[0][0].runId)
    expect(res.script.status).toBe('cancelled')
    expect(t.find(t.isRemove)).toHaveLength(0)
    expect(t.tauri.removeDir).not.toHaveBeenCalled()
  })

  it('A-14 스크립트는 생성 시 1회만 — 기존 worktree 재열기는 실행하지 않음, [다시 실행]은 수동', async () => {
    const t = setup({ mainExists: true, values: { postCreateScript: 'npm ci' } })
    await t.svc.openIssue(ISSUE42)
    await t.svc.openIssue(ISSUE42)
    expect(t.tauri.scriptRun).toHaveBeenCalledTimes(1)
    const again = await t.svc.rerunScript(ISSUE42)
    expect(t.tauri.scriptRun).toHaveBeenCalledTimes(2)
    expect(t.tauri.scriptRun.mock.calls[1][0]).toMatchObject({ cwd: WT42, script: 'npm ci' })
    expect(again).toEqual({ status: 'succeeded', exitCode: 0 })
  })
})

// ── 삭제 ─────────────────────────────────────────────────────────
describe('deleteWorktree (AC-14, EC-15, EC-16, EC-24, PTY 선종료)', () => {
  // EC-24: 저장된 생성 당시 경로는 현재 effective 로 계산한 경로와 다를 수 있다
  const P = '/home/u/custom/MyOrg/Repo-A/issue--42-add-login'

  function setupDelete(sim: Partial<Sim> = {}) {
    const t = setup({
      mainExists: true,
      sim: { worktrees: new Map([[P, BR42]]), local: new Set([BR42]), ...sim },
      entries: [[ID42, { path: P, branch: BR42 }]],
    })
    t.sim.existing.add(P)
    return t
  }

  it('AC-14 변경·미push 없음 → PTY 선종료 → worktree remove(저장된 경로) → 로컬 브랜치 삭제 → 맵 제거', async () => {
    const t = setupDelete()
    await expect(t.svc.deleteWorktree(ISSUE42)).resolves.toEqual({ status: 'deleted' })
    const remove = t.find(t.isRemove)
    expect(remove).toHaveLength(1)
    expect(remove[0]).toContain(P)
    expect(t.tauri.ptyKillByCwd).toHaveBeenCalledWith(P)
    expect(t.tauri.ptyKillByCwd.mock.invocationCallOrder[0]).toBeLessThan(t.callOrder(t.isRemove))
    const del = t.find((a) => a[0] === 'branch' && (a.includes('-d') || a.includes('-D')))
    expect(del).toHaveLength(1)
    expect(del[0]).toContain(BR42)
    expect(t.callOrder(t.isRemove)).toBeLessThan(t.callOrder((a) => a[0] === 'branch' && (a.includes('-d') || a.includes('-D'))))
    expect(t.pathStore.delete).toHaveBeenCalledWith(ID42)
  })

  it('EC-15 미커밋·미push 개수 경고 → 확인 전에는 아무것도 지우지 않음', async () => {
    const t = setupDelete({ dirty: [' M src/a.ts', '?? b.txt'], unpushed: 3 })
    await expect(t.svc.inspect(ISSUE42)).resolves.toEqual({ uncommitted: 2, unpushed: 3 })
    await expect(t.svc.deleteWorktree(ISSUE42)).resolves.toEqual({ status: 'needs_confirmation', uncommitted: 2, unpushed: 3 })
    expect(t.find(t.isRemove)).toHaveLength(0)
    expect(t.tauri.ptyKillByCwd).not.toHaveBeenCalled()
    expect(t.pathStore.delete).not.toHaveBeenCalled()
  })

  it('EC-15 확인 후(confirmed) 진행', async () => {
    const t = setupDelete({ dirty: [' M src/a.ts'], unpushed: 1 })
    await expect(t.svc.deleteWorktree(ISSUE42, { confirmed: true })).resolves.toEqual({ status: 'deleted' })
    expect(t.find(t.isRemove)[0]).toContain(P)
    expect(t.pathStore.delete).toHaveBeenCalledWith(ID42)
  })

  it('EC-16 ★기타는 삭제 불가 — git·PTY 호출 없음', async () => {
    const t = setup({ mainExists: true, entries: [[worktreeId('MyOrg', 'Repo-A', 'etc'), { path: '/home/u/x/etc', branch: 'etc' }]] })
    await expect(t.svc.deleteWorktree(ETC, { confirmed: true })).rejects.toMatchObject({ code: 'etc_not_deletable' })
    expect(t.tauri.gitRun).not.toHaveBeenCalled()
    expect(t.tauri.ptyKillByCwd).not.toHaveBeenCalled()
  })

  it('실행 중인 생성 후 스크립트가 있으면 worktree remove 전에 취소', async () => {
    const run = deferred<ScriptRunResult>()
    const t = setup({
      mainExists: true,
      values: { postCreateScript: 'npm run dev' },
      scriptRun: () => run.promise,
      scriptCancel: async () => run.resolve({ exitCode: null, cancelled: true }),
    })
    const opening = t.svc.openIssue(ISSUE42)
    await vi.waitFor(() => expect(t.tauri.scriptRun).toHaveBeenCalled())
    await expect(t.svc.deleteWorktree(ISSUE42, { confirmed: true })).resolves.toEqual({ status: 'deleted' })
    expect(t.tauri.scriptCancel).toHaveBeenCalled()
    expect(t.tauri.scriptCancel.mock.invocationCallOrder[0]).toBeLessThan(t.callOrder(t.isRemove))
    await opening
  })
})
