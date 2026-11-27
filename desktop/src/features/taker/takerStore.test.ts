// 이슈 테이커 저장 — 이 PC 의 localStorage 에만, 켜고 끌 때의 기준 번호·대기, 확인 중 설정 변경, 정리, 저장 값 검사
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RecentIssue } from '@minmo/core'

import { useSessionStore } from '../../store/session'
import sharedSrc from '../../store/shared.ts?raw'
import pairSyncSrc from '../../store/pairSync.ts?raw'
import peerSyncSrc from '../remote/peerSync.ts?raw'
import { DEFAULT_TAKER_STEPS, TAKER_STORAGE_KEY, defaultTakerConfig, sanitize, useTakerStore } from './takerStore'
import type { TakerRepoConfig, TakerRun, TakerStatus } from './takerStore'

const KEY = 'acme/app'
const OTHER = 'acme/web'

const DEFAULT_STEPS = [
  { kind: 'claude', command: 'claude {prompt}', prompt: '/common:ready-for-impl {issue}' },
  { kind: 'claude', command: 'claude --continue {prompt}', prompt: '/common:start-workflow 위 Spec으로 구현' },
]

const cfg = (o: Partial<TakerRepoConfig> = {}): TakerRepoConfig => ({
  enabled: true,
  author: 'me',
  catchUp: false,
  steps: [{ kind: 'claude', command: 'claude {prompt}', prompt: '/x {issue}' }],
  baseline: null,
  ...o,
})

const issue = (n: number, o: Partial<RecentIssue> = {}): RecentIssue => ({
  number: n,
  title: `Issue ${n}`,
  state: 'open',
  htmlUrl: `https://github.com/acme/app/issues/${n}`,
  assignees: [],
  author: 'me',
  authorAssociation: 'OWNER',
  ...o,
})

const run = (id: string, status: TakerStatus, o: Partial<TakerRun> = {}): TakerRun => ({
  id,
  repoKey: KEY,
  owner: 'acme',
  repo: 'app',
  number: 1,
  title: 't',
  url: '',
  issueId: null,
  steps: [],
  step: 0,
  status,
  paneId: null,
  assigned: false,
  note: null,
  error: null,
  foundAt: 0,
  updatedAt: 0,
  ...o,
})

function reset() {
  useTakerStore.setState({ repos: {}, taken: {}, runs: [], lastCheck: {} })
  localStorage.removeItem(TAKER_STORAGE_KEY)
  useSessionStore.setState(useSessionStore.getInitialState(), true)
}

const state = () => useTakerStore.getState()

beforeEach(() => {
  reset()
  useSessionStore.setState({ token: 'tok', me: { id: 'usr_x', githubLogin: 'me', avatarUrl: null } })
})
afterEach(() => {
  window.history.replaceState(null, '', '/')
  reset()
})

describe('기본값', () => {
  it('AC-02 기본 단계는 ready-for-impl → 앞 대화를 잇는 start-workflow 2단계', () => {
    expect(DEFAULT_TAKER_STEPS).toEqual(DEFAULT_STEPS)
  })

  it('AC-02 기본 설정: 꺼짐 · 내가 쓴 이슈만 · 꺼진 동안 열린 이슈는 실행 안 함 · 기본 2단계 · 기준 번호 없음', () => {
    expect(defaultTakerConfig()).toEqual({ enabled: false, author: 'me', catchUp: false, steps: DEFAULT_STEPS, baseline: null })
  })
})

describe('저장 위치', () => {
  it('AC-14 설정은 localStorage minmo-taker(version 1)에 저장소·실행한 번호·실행 기록만 쓴다', () => {
    expect(TAKER_STORAGE_KEY).toBe('minmo-taker')
    state().saveConfig(KEY, cfg({ author: 'anyone' }))
    const stored = JSON.parse(localStorage.getItem('minmo-taker') ?? 'null') as { version: number; state: Record<string, unknown> }
    expect(stored.version).toBe(1)
    expect(Object.keys(stored.state).sort()).toEqual(['repos', 'runs', 'taken'])
    expect((stored.state.repos as Record<string, TakerRepoConfig>)[KEY]).toMatchObject({ enabled: true, author: 'anyone' })
  })

  it('AC-14 보조 창에서는 localStorage 에 쓰지 않는다', () => {
    window.history.replaceState(null, '', '/?window=ws')
    state().saveConfig(KEY, cfg())
    expect(localStorage.getItem('minmo-taker')).toBeNull()
  })

  it.each([
    ['store/shared.ts', sharedSrc],
    ['features/remote/peerSync.ts', peerSyncSrc],
    ['store/pairSync.ts', pairSyncSrc],
  ])('AC-14 다른 PC·원격 기기와 맞추는 %s 는 이슈 테이커 저장소를 다루지 않는다', (_file, src) => {
    expect(src).toContain('import ')
    expect(src).not.toMatch(/minmo-taker|takerStore|useTakerStore/)
  })
})

describe('saveConfig — 켜기·끄기', () => {
  it('AC-13 끄고 저장하면 그 저장소의 대기는 멈춤이 되고, 시작한 실행과 다른 저장소의 대기는 그대로', () => {
    useTakerStore.setState({
      repos: { [KEY]: cfg({ baseline: 5 }) },
      runs: [run('a', 'queued'), run('b', 'running'), run('c', 'queued', { repoKey: OTHER, repo: 'web' })],
    })
    state().saveConfig(KEY, cfg({ enabled: false, baseline: 5 }))
    expect(state().runs.map((r) => [r.id, r.status])).toEqual([
      ['a', 'stopped'],
      ['b', 'running'],
      ['c', 'queued'],
    ])
    expect(state().repos[KEY].enabled).toBe(false)
  })

  it('AC-13 다시 켜고 저장하면 기준 번호를 새로 잡게 null 로 둔다(처음 켤 때도 같다)', () => {
    useTakerStore.setState({ repos: { [KEY]: cfg({ enabled: false, baseline: 20 }) } })
    state().saveConfig(KEY, cfg({ enabled: true, baseline: 20 }))
    expect(state().repos[KEY].baseline).toBeNull()
    state().saveConfig(OTHER, cfg({ enabled: true, baseline: 7 }))
    expect(state().repos[OTHER].baseline).toBeNull()
  })

})

describe('setBaseline · addRuns — 확인 중에 설정이 바뀜', () => {
  it('EC-31 저장한 뒤의 옛 설정으로는 setBaseline 이 false 이고 기준 번호를 바꾸지 않는다(같은 값으로 저장해도)', () => {
    const old = cfg()
    useTakerStore.setState({ repos: { [KEY]: old } })
    state().saveConfig(KEY, { ...old })
    expect(state().setBaseline(KEY, 10, old)).toBe(false)
    expect(state().repos[KEY].baseline).toBeNull()
  })

  it.each<[number, number | null, number[], number]>([
    [10, null, [], 10],
    [5, 8, [], 8],
    [5, null, [9], 9],
  ])('EC-31 setBaseline(%i) — 지금 기준 %s · 실행한 번호 %j → true, 기준 번호 %i (줄지 않음)', (n, baseline, taken, expected) => {
    const c = cfg({ baseline })
    useTakerStore.setState({ repos: { [KEY]: c }, taken: { [KEY]: taken } })
    expect(state().setBaseline(KEY, n, c)).toBe(true)
    expect(state().repos[KEY].baseline).toBe(expected)
  })

  it('EC-31 옛 설정으로는 addRuns 가 false 이고 실행을 더하지 않는다', () => {
    const old = cfg({ baseline: 10 })
    useTakerStore.setState({ repos: { [KEY]: old } })
    state().saveConfig(KEY, { ...old })
    expect(state().addRuns(KEY, [issue(11)], old)).toBe(false)
    expect(state().runs).toEqual([])
    expect(state().taken[KEY] ?? []).toEqual([])
  })

  it('EC-31 기준 번호가 없으면(null) addRuns 는 모두 거른다', () => {
    const c = cfg({ baseline: null })
    useTakerStore.setState({ repos: { [KEY]: c } })
    state().addRuns(KEY, [issue(11)], c)
    expect(state().runs).toEqual([])
  })

  it('EC-31 addRuns 는 지금 설정으로 다시 걸러 맞는 이슈만 대기로 더하고 그 번호를 taken 에 넣는다', () => {
    const c = cfg({ author: 'me', baseline: 10 })
    useTakerStore.setState({ repos: { [KEY]: c } })
    expect(state().addRuns(KEY, [issue(11), issue(12, { author: 'other', authorAssociation: 'NONE' }), issue(9)], c)).toBe(true)
    expect(state().runs).toHaveLength(1)
    expect(state().runs[0]).toMatchObject({
      repoKey: KEY,
      number: 11,
      title: 'Issue 11',
      url: 'https://github.com/acme/app/issues/11',
      steps: c.steps,
      step: 0,
      status: 'queued',
      paneId: null,
      assigned: false,
    })
    expect(state().taken[KEY]).toEqual([11])
  })

  it('EC-03 같은 이슈를 두 번 받아도 실행은 하나', () => {
    const c = cfg({ baseline: 10 })
    useTakerStore.setState({ repos: { [KEY]: c } })
    state().addRuns(KEY, [issue(11)], c)
    state().addRuns(KEY, [issue(11)], useTakerStore.getState().repos[KEY])
    expect(state().runs.filter((r) => r.number === 11)).toHaveLength(1)
  })
})

describe('정리', () => {
  it('A-20 끝난 실행은 저장소마다 최근 30개만 남긴다', () => {
    const c = cfg({ baseline: 100 })
    const done = Array.from({ length: 35 }, (_, i) => run(`d${i}`, 'done', { number: i + 1, updatedAt: i }))
    useTakerStore.setState({
      repos: { [KEY]: c },
      runs: [...done, run('o1', 'done', { repoKey: OTHER, repo: 'web' }), run('o2', 'done', { repoKey: OTHER, repo: 'web' }), run('q', 'queued', { number: 99 })],
    })
    state().addRuns(KEY, [issue(101)], c)
    const runs = state().runs
    const kept = runs.filter((r) => r.repoKey === KEY && r.status === 'done').map((r) => r.updatedAt)
    expect(kept.sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 5))
    expect(runs.filter((r) => r.repoKey === OTHER)).toHaveLength(2)
    expect(runs.some((r) => r.id === 'q')).toBe(true)
    expect(runs.some((r) => r.number === 101 && r.status === 'queued')).toBe(true)
  })

  it('A-20 taken 은 기준 번호보다 큰 번호만 남긴다', () => {
    const c = cfg({ baseline: 10 })
    useTakerStore.setState({ repos: { [KEY]: c }, taken: { [KEY]: [3, 11] } })
    state().addRuns(KEY, [issue(12)], c)
    expect([...state().taken[KEY]].sort((a, b) => a - b)).toEqual([11, 12])
  })
})

describe('sanitize — 저장 값 검사', () => {
  const EMPTY = { repos: {}, taken: {}, runs: [] }

  it.each([null, 'x', 42, { repos: 'x', taken: [], runs: {} }])('AC-14 저장 값이 없거나 모양이 틀리면(%j) 빈 기본값', (raw) => {
    expect(sanitize(raw)).toEqual(EMPTY)
  })

  it('AC-14 저장소 설정의 잘못된 값은 기본값으로 바꾼다', () => {
    const raw = { repos: { [KEY]: { enabled: 'yes', author: 'boss', catchUp: 1, steps: 'x', baseline: '7' } } }
    expect(sanitize(raw).repos[KEY]).toEqual({ enabled: false, author: 'me', catchUp: false, steps: DEFAULT_STEPS, baseline: null })
  })

  it('AC-14 맞는 값은 그대로 둔다', () => {
    const raw = { repos: { [KEY]: cfg({ baseline: 10, catchUp: true, author: 'writers' }) }, taken: { [KEY]: [11] }, runs: [run('a', 'running', { number: 11 })] }
    expect(sanitize(raw)).toEqual(raw)
  })
})
