// 고르지 않고 이슈 열기 — select:false 는 선택을 바꾸지 않고, 여는 중인 같은 이슈를 다시 열면 그 열기(스크립트 끝)까지 기다린다
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Effective } from '@minmo/api-client'
import { DEFAULT_SETTINGS, worktreeId } from '@minmo/core'
import type { IssueTarget } from '@minmo/core'

import type { TauriApi } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub, createFakeTauri, deferred, ok } from '../../test/fakes'
import { makeDeps, makeWrapper } from '../../test/render'
import { WorktreeProvider, useIssueActions } from './useWorktree'

const T: IssueTarget = { owner: 'acme', repo: 'app', key: '7', number: 7, title: 'Fix' }
const ID = worktreeId(T.owner, T.repo, T.key)

function setup(tauriOverrides: Partial<TauriApi> = {}) {
  const { tauri } = createFakeTauri(tauriOverrides)
  const api = createFakeApi({
    getEffective: async () => ({ values: { ...DEFAULT_SETTINGS, postCreateScriptPosix: 'npm ci' }, sources: {} }) as unknown as Effective,
  })
  const Base = makeWrapper(makeDeps({ tauri, api, github: createFakeGitHub({ defaultBranch: async () => 'main' }) }))
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Base>
      <WorktreeProvider>{children}</WorktreeProvider>
    </Base>
  )
  const { result } = renderHook(() => useIssueActions(), { wrapper })
  return { tauri, actions: () => result.current }
}

/** promise 가 끝났는지 — 끝나기 전에는 false */
function settled(p: Promise<unknown>) {
  const s = { done: false }
  void p.then(() => {
    s.done = true
  })
  return s
}

const flushAll = () => act(() => new Promise((r) => setTimeout(r, 0)))

beforeEach(() => {
  localStorage.clear()
  useHostsStore.setState({ aliases: [], selected: null, probes: {}, connecting: {}, errors: {}, baseRepos: {}, baseDirs: {}, repoHosts: {} })
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
  useSetupStore.setState(useSetupStore.getInitialState(), true)
  useUiStore.setState({ worktreePathMap: {}, selectedIssueId: null, selectSeq: 0 })
})

describe('IssueActions.open — 고르지 않고 열기', () => {
  it('AC-05 open(t, { select: false }) 는 이슈를 고르지 않고 대상·열기 상태만 기록한다', async () => {
    const { actions } = setup()
    await act(() => actions().open(T, { select: false }))
    expect(useUiStore.getState()).toMatchObject({ selectedIssueId: null, selectSeq: 0 })
    expect(useSetupStore.getState().targets[ID]).toEqual(T)
    expect(useSetupStore.getState().open[ID]).toMatchObject({ phase: 'ready' })
  })

  it('AC-05 open(t) 기본값은 지금처럼 이슈를 고른다', async () => {
    const { actions } = setup()
    await act(() => actions().open(T))
    expect(useUiStore.getState()).toMatchObject({ selectedIssueId: ID, selectSeq: 1 })
  })

  it('AC-05 여는 중인 같은 이슈를 다시 열면 바로 돌아오지 않고 첫 열기가 끝날 때까지 기다린다', async () => {
    const clone = deferred<ReturnType<typeof ok>>()
    const { actions } = setup({ gitRun: async (args) => (args[0] === 'clone' ? clone.promise : ok()) })
    const first = settled(actions().open(T))
    await waitFor(() => expect(useSetupStore.getState().open[ID]).toMatchObject({ phase: 'opening' }))
    const second = settled(actions().open(T, { select: false }))
    await flushAll()
    expect(second.done).toBe(false)
    await act(async () => clone.resolve(ok()))
    await waitFor(() => expect(first.done).toBe(true))
    await waitFor(() => expect(second.done).toBe(true))
    expect(useSetupStore.getState().open[ID]).toMatchObject({ phase: 'ready' })
  })

  it('AC-05 ready 가 됐지만 생성 후 스크립트가 아직 시작 전인 틈에 다시 열어도 스크립트가 끝날 때까지 기다린다', async () => {
    useUiStore.setState({ worktreePathMap: { [ID]: { path: '/old/issue-7', branch: 'issue/7' } } })
    const copy = deferred<number>()
    const script = deferred<{ exitCode: number; cancelled: boolean }>()
    const { tauri, actions } = setup({ copyTree: () => copy.promise, scriptRun: () => script.promise })
    const first = settled(actions().open(T))
    await waitFor(() => expect(tauri.copyTree).toHaveBeenCalled())
    expect(useSetupStore.getState().open[ID]).toMatchObject({ phase: 'ready' })
    expect(useSetupStore.getState().script[ID]).toBeUndefined()
    const second = settled(actions().open(T, { select: false }))
    await flushAll()
    expect(second.done).toBe(false)
    await act(async () => copy.resolve(0))
    await waitFor(() => expect(tauri.scriptRun).toHaveBeenCalledTimes(1))
    await flushAll()
    expect(second.done).toBe(false)
    await act(async () => script.resolve({ exitCode: 0, cancelled: false }))
    await waitFor(() => expect(first.done).toBe(true))
    await waitFor(() => expect(second.done).toBe(true))
    expect(tauri.scriptRun).toHaveBeenCalledTimes(1)
  })
})
