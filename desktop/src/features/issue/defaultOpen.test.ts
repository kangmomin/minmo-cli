// 기본 작업 공간 열기 (#120) — worktree 서비스·서버·GitHub 를 부르지 않고 그 호스트의 홈을 바로 연다
import { beforeEach, describe, expect, it } from 'vitest'

import { hostOf } from '../../app/host'
import { DEFAULT_CORE_ID, DEFAULT_TARGET } from '../../lib/defaultWorkspace'
import type { SshProbe } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { ensureDefaultOpen, homeOf, openDefault } from './defaultOpen'

const PROBE: SshProbe = { platform: 'linux', home: '/home/dev', git: 'git version 2.43.0', tmux: true }
const REMOTE_DEF = `ssh:srv|${DEFAULT_CORE_ID}`

beforeEach(() => {
  useSetupStore.setState({ open: {}, targets: {}, logs: {} })
  useHostsStore.setState({ probes: {} })
  useUiStore.setState({ selectedIssueId: null, selectSeq: 0, tab: 'notes' })
})

describe('openDefault', () => {
  it('AC-02 기본을 고르면 그 호스트의 기본(호스트마다 다른 id)을 고르고 터미널 탭으로, 홈을 작업 폴더로 바로 준비한다', () => {
    openDefault(hostOf('srv'), '/home/dev')
    const setup = useSetupStore.getState()
    expect(setup.targets[REMOTE_DEF]).toEqual(DEFAULT_TARGET)
    expect(setup.open[REMOTE_DEF]).toEqual({ phase: 'ready', path: '/home/dev', branch: '', pathChanged: false })
    expect(useUiStore.getState()).toMatchObject({ selectedIssueId: REMOTE_DEF, selectSeq: 1, tab: 'terminal' })
    openDefault(hostOf(null), '/home/u')
    expect(useUiStore.getState().selectedIssueId).toBe(DEFAULT_CORE_ID)
    expect(useSetupStore.getState().open[DEFAULT_CORE_ID]).toMatchObject({ phase: 'ready', path: '/home/u' })
  })
})

describe('homeOf', () => {
  it('AC-03 이 PC 는 이 PC 의 홈, SSH 호스트는 그 호스트의 홈(probe.home)', () => {
    useHostsStore.getState().setProbe('srv', PROBE)
    expect(homeOf(null, '/home/u')).toBe('/home/u')
    expect(homeOf('srv', '/home/u')).toBe('/home/dev')
  })

  it('EC-14 고른 원격 호스트의 연결 정보(probe)가 없으면 이 PC 의 홈으로 떨어지지 않는다(null)', () => {
    useHostsStore.getState().setProbe('srv', PROBE)
    expect(homeOf('srv', '/home/u')).toBe('/home/dev')
    useHostsStore.setState({ probes: {} })
    expect(homeOf('srv', '/home/u')).toBeNull()
  })
})

describe('ensureDefaultOpen', () => {
  it('EC-14 홈을 모르면(null) 열기 상태는 error "호스트에 연결되지 않았습니다"', () => {
    ensureDefaultOpen(REMOTE_DEF, null)
    expect(useSetupStore.getState().targets[REMOTE_DEF]).toEqual(DEFAULT_TARGET)
    expect(useSetupStore.getState().open[REMOTE_DEF]).toMatchObject({ phase: 'error', message: '호스트에 연결되지 않았습니다' })
  })

  it('EC-18 다시 만들 때 선택·작업 탭은 건드리지 않는다(좁은 화면이 작업 화면으로 넘어가지 않게)', () => {
    ensureDefaultOpen(DEFAULT_CORE_ID, '/home/u')
    expect(useSetupStore.getState().open[DEFAULT_CORE_ID]).toEqual({ phase: 'ready', path: '/home/u', branch: '', pathChanged: false })
    expect(useUiStore.getState()).toMatchObject({ selectedIssueId: null, selectSeq: 0, tab: 'notes' })
  })

  it('EC-18 이미 같은 홈으로 준비돼 있으면 다시 쓰지 않는다(같은 참조)', () => {
    ensureDefaultOpen(DEFAULT_CORE_ID, '/home/u')
    const first = useSetupStore.getState().open[DEFAULT_CORE_ID]
    expect(first).toMatchObject({ phase: 'ready', path: '/home/u' })
    ensureDefaultOpen(DEFAULT_CORE_ID, '/home/u')
    expect(useSetupStore.getState().open[DEFAULT_CORE_ID]).toBe(first)
  })

  it('EC-18 error 뒤 호스트가 준비되면(probe 가 오면) ready 로 다시 만든다', () => {
    ensureDefaultOpen(REMOTE_DEF, homeOf('srv', '/home/u'))
    expect(useSetupStore.getState().open[REMOTE_DEF]).toMatchObject({ phase: 'error' })
    useHostsStore.getState().setProbe('srv', PROBE)
    ensureDefaultOpen(REMOTE_DEF, homeOf('srv', '/home/u'))
    expect(useSetupStore.getState().open[REMOTE_DEF]).toEqual({ phase: 'ready', path: '/home/dev', branch: '', pathChanged: false })
  })
})
