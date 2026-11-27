// 이슈 테이커 진행 표시 — 머리줄의 단계·상태·버튼, 트리 줄의 ↻, 주 창이 아닐 때(actions 없음) 숨김
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { worktreeId } from '@minmo/core'

import { TakerHeaderStatus, TakerRowIcon } from './TakerStatus'
import { TAKER_STORAGE_KEY, useTakerStore } from './takerStore'
import type { TakerRun, TakerStatus, TakerStep } from './takerStore'
import { TakerActionsProvider } from './useIssueTaker'
import type { TakerActions } from './useIssueTaker'

const ID = worktreeId('acme', 'app', '120')
const STEPS: TakerStep[] = [
  { kind: 'claude', command: 'claude {prompt}', prompt: '/common:ready-for-impl {issue}' },
  { kind: 'claude', command: 'claude --continue {prompt}', prompt: '/common:start-workflow 위 Spec으로 구현' },
]

const runOf = (status: TakerStatus, o: Partial<TakerRun> = {}): TakerRun => ({
  id: 'r120',
  repoKey: 'acme/app',
  owner: 'acme',
  repo: 'app',
  number: 120,
  title: '로그인 수정',
  url: 'https://github.com/acme/app/issues/120',
  issueId: ID,
  steps: STEPS,
  step: 0,
  status,
  paneId: `${ID}::1`,
  assigned: true,
  note: null,
  error: null,
  foundAt: 1,
  updatedAt: 1,
  ...o,
})

function seed(runs: TakerRun[]) {
  useTakerStore.setState({ repos: {}, taken: {}, runs, lastCheck: {} })
}

function fakeActions(o: Partial<TakerActions> = {}): TakerActions {
  return { stop: vi.fn(), restart: vi.fn(), nextStep: vi.fn(() => 'started' as const), ...o }
}

function renderWith(ui: ReactNode, actions: TakerActions | null = fakeActions()) {
  return { ...render(<TakerActionsProvider value={actions}>{ui}</TakerActionsProvider>), actions, user: userEvent.setup() }
}

beforeEach(() => {
  localStorage.removeItem(TAKER_STORAGE_KEY)
  seed([])
})
afterEach(() => {
  seed([])
  localStorage.removeItem(TAKER_STORAGE_KEY)
})

describe('TakerHeaderStatus — 머리줄 진행', () => {
  it('AC-06 실행 중이면 "자동 실행 {i}/{n} 단계" 를 보이고, 화면 낭독기에는 "{n}단계 중 {i}단계" 와 상태를 status 로 알린다', () => {
    seed([runOf('running')])
    renderWith(<TakerHeaderStatus issueId={ID} />)
    expect(screen.getByText(/자동 실행 1\/2 단계/)).toBeInTheDocument()
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('2단계 중 1단계')
    expect(status).toHaveTextContent('실행 중')
  })

  it('AC-06 그 이슈에 실행이 없어도 status 영역은 미리 있다(나중에 바뀐 내용을 알릴 수 있게)', () => {
    seed([runOf('running', { issueId: worktreeId('acme', 'app', '7') })])
    const { container } = renderWith(<TakerHeaderStatus issueId={ID} />)
    expect(within(container).getByRole('status')).toBeInTheDocument()
    expect(screen.queryByText(/자동 실행 1\/2 단계/)).toBeNull()
  })

  it('AC-08 [자동 실행 멈춤] 을 누르면 그 실행의 stop 을 부른다', async () => {
    seed([runOf('running')])
    const { actions, user } = renderWith(<TakerHeaderStatus issueId={ID} />)
    const stop = screen.getByRole('button', { name: '자동 실행 멈춤' })
    expect(stop).toHaveAttribute('type', 'button')
    await user.click(stop)
    expect(actions!.stop).toHaveBeenCalledWith('r120')
  })

  it('EC-04 실패하면 사유를 alert 로 알리고, [자동 실행 다시 시도] 는 restart 를 부른다', async () => {
    seed([runOf('failed', { error: '에이전트가 시작되지 않음' })])
    const { actions, user } = renderWith(<TakerHeaderStatus issueId={ID} />)
    expect(screen.getByRole('alert')).toHaveTextContent('에이전트가 시작되지 않음')
    await user.click(screen.getByRole('button', { name: '자동 실행 다시 시도' }))
    expect(actions!.restart).toHaveBeenCalledWith('r120')
    expect(screen.queryByRole('button', { name: '자동 실행 멈춤' })).toBeNull()
  })

  it('EC-06 중단됨이면 [이 단계부터 다시] 가 restart 를 부른다', async () => {
    seed([runOf('interrupted', { step: 1 })])
    const { actions, user } = renderWith(<TakerHeaderStatus issueId={ID} />)
    expect(screen.getByRole('status')).toHaveTextContent('중단됨')
    await user.click(screen.getByRole('button', { name: '이 단계부터 다시' }))
    expect(actions!.restart).toHaveBeenCalledWith('r120')
  })

  it('EC-07 다음 단계 대기에서 [다음 단계] 를 누르면 nextStep 을 부르고, 시작했으면(started) 버튼을 잠근다', async () => {
    seed([runOf('manualNext')])
    const { actions, user } = renderWith(<TakerHeaderStatus issueId={ID} />)
    const next = screen.getByRole('button', { name: '다음 단계' })
    expect(next).toBeEnabled()
    await user.click(next)
    expect(actions!.nextStep).toHaveBeenCalledWith('r120')
    expect(screen.getByRole('button', { name: '다음 단계' })).toBeDisabled()
  })

  it.each(['busy', 'notReady'] as const)('EC-07 nextStep 이 %s 면 [다음 단계] 잠금을 바로 푼다', async (result) => {
    seed([runOf('manualNext')])
    const { actions, user } = renderWith(<TakerHeaderStatus issueId={ID} />, fakeActions({ nextStep: vi.fn(() => result) }))
    await user.click(screen.getByRole('button', { name: '다음 단계' }))
    expect(actions!.nextStep).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '다음 단계' })).toBeEnabled()
  })

  it('EC-07 nextStep 이 notReady 면 status 영역에 "연결을 기다리는 중 — 잠시 뒤 다시 누르세요" 를 알린다', async () => {
    seed([runOf('manualNext')])
    const { user } = renderWith(<TakerHeaderStatus issueId={ID} />, fakeActions({ nextStep: vi.fn(() => 'notReady' as const) }))
    await user.click(screen.getByRole('button', { name: '다음 단계' }))
    expect(screen.getByRole('status')).toHaveTextContent('연결을 기다리는 중 — 잠시 뒤 다시 누르세요')
  })

  it('AC-07 포커스가 있던 버튼이 상태가 바뀌어 사라지면 포커스를 상태 글로 옮긴다', () => {
    seed([runOf('running', { step: 1 })])
    renderWith(<TakerHeaderStatus issueId={ID} />)
    const stop = screen.getByRole('button', { name: '자동 실행 멈춤' })
    act(() => stop.focus())
    act(() => useTakerStore.setState({ runs: [runOf('done', { step: 1 })] }))
    expect(screen.queryByRole('button', { name: '자동 실행 멈춤' })).toBeNull()
    expect(document.activeElement).not.toBe(document.body)
    expect(screen.getByRole('status')).toContainElement(document.activeElement as HTMLElement)
  })

  it('EC-16 actions 가 없으면(보조 창·원격 화면) 아무것도 그리지 않는다', () => {
    seed([runOf('running')])
    const { container } = renderWith(<TakerHeaderStatus issueId={ID} />, null)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('TakerRowIcon — 트리 줄 ↻', () => {
  it('AC-06 자동 실행 중인 이슈 줄에 ↻(role=img, "자동 실행 중") 을 보이고, 끝난 실행에는 보이지 않는다', () => {
    seed([runOf('running')])
    renderWith(<TakerRowIcon issueId={ID} />)
    const icon = screen.getByRole('img', { name: '자동 실행 중' })
    expect(icon).toHaveTextContent('↻')
    act(() => useTakerStore.setState({ runs: [runOf('done', { step: 1 })] }))
    expect(screen.queryByRole('img', { name: '자동 실행 중' })).toBeNull()
  })

  it('EC-16 actions 가 없으면 ↻ 을 그리지 않는다', () => {
    seed([runOf('running')])
    const { container } = renderWith(<TakerRowIcon issueId={ID} />, null)
    expect(container).toBeEmptyDOMElement()
  })
})
