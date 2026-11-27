// 이슈 테이커 훅 — 주 창에서만 엔진을 돌리고(시작·5분 확인·1초 진행·켜기 저장 즉시 확인), 언마운트하면 정리한다
import { QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { worktreeId } from '@minmo/core'
import type { GitHubClient } from '@minmo/core'

import { DepsProvider } from '../../app/deps'
import type { AppDeps } from '../../app/deps'
import type { RuntimeKind } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeGitHub, createFakeTauri } from '../../test/fakes'
import { makeDeps, makeQueryClient } from '../../test/render'
import { useAgentStore } from '../agents/agentStore'
import { resetLaunchQueue } from '../agents/launchQueue'
import { WorktreeProvider } from '../issue/useWorktree'
import { TAKER_STORAGE_KEY, useTakerStore } from './takerStore'
import type { TakerRepoConfig, TakerRun, TakerStep } from './takerStore'
import { TakerActionsProvider, useIssueTaker, useTakerActions } from './useIssueTaker'
import type { TakerActions } from './useIssueTaker'

const KEY = 'acme/app'
const ID = worktreeId('acme', 'app', '11')
const STEPS: TakerStep[] = [
  { kind: 'claude', command: 'claude {prompt}', prompt: '/ready {number}' },
  { kind: 'claude', command: 'claude --continue {prompt}', prompt: '/impl {number}' },
]

const cfg = (o: Partial<TakerRepoConfig> = {}): TakerRepoConfig => ({ enabled: true, author: 'me', catchUp: false, steps: STEPS, baseline: 10, ...o })

const runOf = (n: number, o: Partial<TakerRun> = {}): TakerRun => ({
  id: `r${n}`,
  repoKey: KEY,
  owner: 'acme',
  repo: 'app',
  number: n,
  title: `Issue ${n}`,
  url: `https://github.com/acme/app/issues/${n}`,
  issueId: null,
  steps: STEPS,
  step: 0,
  status: 'queued',
  paneId: null,
  assigned: false,
  note: null,
  error: null,
  foundAt: n,
  updatedAt: 0,
  ...o,
})

const RUNNING = runOf(11, { status: 'running', issueId: ID, paneId: `${ID}::1`, assigned: true })

function seed(runs: TakerRun[], repos: Record<string, TakerRepoConfig> = { [KEY]: cfg() }) {
  useTakerStore.setState({ repos, runs, taken: {} })
}
const run = (id = 'r11') => useTakerStore.getState().runs.find((r) => r.id === id)

let seen: TakerActions | null | undefined

function Reader() {
  seen = useTakerActions()
  return null
}

function Host() {
  const actions = useIssueTaker()
  return (
    <TakerActionsProvider value={actions}>
      <Reader />
    </TakerActionsProvider>
  )
}

function setup(o: { runtime?: RuntimeKind; github?: Partial<GitHubClient> } = {}) {
  const unlistenExit = vi.fn()
  const unlistenLink = vi.fn()
  const { tauri } = createFakeTauri({
    ...(o.runtime ? { runtime: o.runtime } : {}),
    onPtyExit: async () => unlistenExit,
    onPtyLink: async () => unlistenLink,
  })
  const github = createFakeGitHub(o.github)
  const deps = makeDeps({ tauri, github })
  const queryClient = makeQueryClient()
  const tree = (d: AppDeps) => (
    <QueryClientProvider client={queryClient}>
      <DepsProvider value={d}>
        <WorktreeProvider>
          <Host />
        </WorktreeProvider>
      </DepsProvider>
    </QueryClientProvider>
  )
  const r = render(tree(deps))
  return { ...r, tauri, github, deps, unlistenExit, unlistenLink, rerenderWith: (d: AppDeps) => r.rerender(tree(d)) }
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

beforeEach(() => {
  vi.useFakeTimers()
  seen = undefined
  window.history.replaceState(null, '', '/')
  localStorage.removeItem(TAKER_STORAGE_KEY)
  localStorage.clear()
  useTakerStore.setState({ repos: {}, taken: {}, runs: [], lastCheck: {} })
  useUiStore.setState(useUiStore.getInitialState(), true)
  useSetupStore.setState({ targets: {}, open: {}, script: {}, logs: {} })
  useAgentStore.setState({ panes: {}, subagents: {}, shellSince: {} })
  useHostsStore.setState(useHostsStore.getInitialState(), true)
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', me: { id: 'usr_x', githubLogin: 'me', avatarUrl: null } })
  resetLaunchQueue()
})
afterEach(() => {
  vi.useRealTimers()
  window.history.replaceState(null, '', '/')
  resetLaunchQueue()
  useTakerStore.setState({ repos: {}, taken: {}, runs: [], lastCheck: {} })
  localStorage.removeItem(TAKER_STORAGE_KEY)
})

describe('useIssueTaker — 주 창의 엔진', () => {
  it('AC-03 마운트하면 엔진을 시작하고(진행 중이던 실행은 중단됨) 바로 확인한다', async () => {
    seed([RUNNING], { [KEY]: cfg({ baseline: null }) })
    const h = setup()
    await advance(0)
    expect(h.github.latestNumber).toHaveBeenCalledTimes(1)
    expect(h.github.latestNumber).toHaveBeenCalledWith('acme', 'app')
    expect(run()?.status).toBe('interrupted')
  })

  it('AC-04 5분마다 다시 확인한다', async () => {
    seed([], { [KEY]: cfg({ catchUp: true }) })
    const h = setup()
    await advance(0)
    expect(h.github.listRecentIssues).toHaveBeenCalledTimes(1)
    await advance(299_000)
    expect(h.github.listRecentIssues).toHaveBeenCalledTimes(1)
    await advance(1_000)
    expect(h.github.listRecentIssues).toHaveBeenCalledTimes(2)
    await advance(300_000)
    expect(h.github.listRecentIssues).toHaveBeenCalledTimes(3)
  })

  it('AC-04 1초마다 실행을 진행한다', async () => {
    seed([runOf(11)])
    const h = setup()
    await advance(1_000)
    expect(run()?.status).not.toBe('queued')
    await advance(3_000)
    expect(h.github.getIssue).toHaveBeenCalledWith('acme', 'app', 11)
  })

  it('AC-03 켜기를 저장하면 5분을 기다리지 않고 바로 확인한다', async () => {
    seed([], { [KEY]: cfg({ enabled: false, baseline: null }) })
    const h = setup()
    await advance(0)
    expect(h.github.latestNumber).not.toHaveBeenCalled()
    act(() => useTakerStore.setState({ repos: { [KEY]: cfg({ enabled: true, baseline: null }) } }))
    await advance(0)
    expect(h.github.latestNumber).toHaveBeenCalledTimes(1)
  })

  it('A-26 언마운트하면 타이머를 멈추고 터미널 이벤트 구독을 푼다', async () => {
    seed([], { [KEY]: cfg({ catchUp: true }) })
    const h = setup()
    await advance(0)
    expect(h.tauri.onPtyExit).toHaveBeenCalledTimes(1)
    expect(h.tauri.onPtyLink).toHaveBeenCalledTimes(1)
    expect(h.github.listRecentIssues).toHaveBeenCalledTimes(1)
    h.unmount()
    await advance(0)
    expect(h.unlistenExit).toHaveBeenCalledTimes(1)
    expect(h.unlistenLink).toHaveBeenCalledTimes(1)
    await advance(600_000)
    expect(h.github.listRecentIssues).toHaveBeenCalledTimes(1)
  })

  it('A-26 언마운트한 뒤 다시 마운트하면 진행 중이던 실행은 중단됨이 된다', async () => {
    seed([], {})
    const first = setup()
    await advance(0)
    act(() => useTakerStore.setState({ runs: [RUNNING] }))
    first.unmount()
    expect(run()?.status).toBe('running')
    expect(first.tauri.onPtyExit).toHaveBeenCalledTimes(1)
    setup()
    await advance(0)
    expect(run()?.status).toBe('interrupted')
  })

  it('A-26 다시 렌더링해도(새 deps) 엔진을 다시 만들지 않아 진행 중인 실행을 다시 중단시키지 않는다', async () => {
    seed([], {})
    const h = setup()
    await advance(0)
    expect(h.tauri.onPtyExit).toHaveBeenCalledTimes(1)
    act(() => useTakerStore.setState({ runs: [RUNNING] }))
    h.rerenderWith({ ...h.deps })
    await advance(0)
    expect(h.tauri.onPtyExit).toHaveBeenCalledTimes(1)
    expect(h.unlistenExit).not.toHaveBeenCalled()
    expect(run()?.status).toBe('running')
  })

  it.each<[string, () => void, RuntimeKind | undefined]>([
    ['보조 창(?window=ws)', () => window.history.replaceState(null, '', '/?window=ws'), undefined],
    ['원격 화면(runtime remote)', () => {}, 'remote'],
  ])('EC-16 %s 에서는 엔진을 돌리지 않고 actions 는 null', async (_case, arrange, runtime) => {
    arrange()
    seed([runOf(11)], { [KEY]: cfg({ baseline: null }) })
    const h = setup({ runtime })
    await advance(10_000)
    expect(h.github.latestNumber).not.toHaveBeenCalled()
    expect(h.tauri.onPtyExit).not.toHaveBeenCalled()
    expect(run()?.status).toBe('queued')
    expect(seen).toBeNull()
  })

  it('A-23 mock 런타임의 주 창에서도 엔진이 돌고, actions 의 stop 이 실행을 멈춘다', async () => {
    seed([runOf(11)])
    const h = setup()
    await advance(0)
    expect(h.tauri.onPtyExit).toHaveBeenCalledTimes(1)
    expect(seen).toEqual({ stop: expect.any(Function), restart: expect.any(Function), nextStep: expect.any(Function) })
    act(() => seen!.stop('r11'))
    expect(run()?.status).toBe('stopped')
  })

  it('A-23 켜진 저장소와 실행이 없으면 엔진은 돌아도 store 에 쓰지 않고 GitHub 를 부르지 않는다', async () => {
    seed([], {})
    let writes = 0
    const count = () => {
      writes++
    }
    const unsubs = [useTakerStore, useUiStore, useSetupStore, useAgentStore, useHostsStore].map((s) => s.subscribe(count))
    const h = setup()
    await advance(0)
    expect(h.tauri.onPtyExit).toHaveBeenCalledTimes(1)
    await advance(600_000)
    for (const u of unsubs) u()
    expect(writes).toBe(0)
    expect(Object.entries(h.github).filter(([, fn]) => typeof fn === 'function' && fn.mock.calls.length > 0).map(([k]) => k)).toEqual([])
    expect(localStorage.getItem(TAKER_STORAGE_KEY)).toBeNull()
  })
})
