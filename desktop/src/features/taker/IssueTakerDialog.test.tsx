// 이슈 테이커 대화상자 — 기본값·저장(이 PC), 단계 편집(추가·삭제·순서·포커스·알림), 검사·경고·안내, 실행 목록과 마지막 확인
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '../../components/ui/tooltip'
import { useHostsStore } from '../../store/hosts'
import { useSessionStore } from '../../store/session'
import { makeDeps, renderWithDeps } from '../../test/render'
import { buildCommand } from '../agents/launch'
import { IssueTakerDialog } from './IssueTakerDialog'
import { TAKER_STORAGE_KEY, useTakerStore } from './takerStore'
import type { TakerRepoConfig, TakerRun, TakerStatus, TakerStep } from './takerStore'
import { TakerActionsProvider } from './useIssueTaker'
import type { TakerActions } from './useIssueTaker'

const KEY = 'acme/app'
const DEFAULT_STEPS: TakerStep[] = [
  { kind: 'claude', command: 'claude {prompt}', prompt: '/common:ready-for-impl {issue}' },
  { kind: 'claude', command: 'claude --continue {prompt}', prompt: '/common:start-workflow 위 Spec으로 구현' },
]

const cfg = (o: Partial<TakerRepoConfig> = {}): TakerRepoConfig => ({
  enabled: true,
  author: 'me',
  catchUp: false,
  steps: DEFAULT_STEPS,
  baseline: 10,
  ...o,
})

const runOf = (n: number, status: TakerStatus, o: Partial<TakerRun> = {}): TakerRun => ({
  id: `r${n}`,
  repoKey: KEY,
  owner: 'Acme',
  repo: 'App',
  number: n,
  title: `이슈 ${n}`,
  url: `https://github.com/Acme/App/issues/${n}`,
  issueId: `acme/app#${n}`,
  steps: DEFAULT_STEPS,
  step: 0,
  status,
  paneId: null,
  assigned: true,
  note: null,
  error: null,
  foundAt: n,
  updatedAt: n,
  ...o,
})

function fakeActions(): TakerActions {
  return { stop: vi.fn(), restart: vi.fn(), nextStep: vi.fn(() => 'started' as const) }
}

function setup(o: { repos?: Record<string, TakerRepoConfig>; runs?: TakerRun[]; lastCheck?: Record<string, { at: number; error: string | null }> } = {}) {
  useTakerStore.setState({ repos: o.repos ?? {}, taken: {}, runs: o.runs ?? [], lastCheck: o.lastCheck ?? {} })
  const actions = fakeActions()
  const onOpenChange = vi.fn()
  renderWithDeps(
    <TooltipProvider>
      <TakerActionsProvider value={actions}>
        <IssueTakerDialog owner="Acme" repo="App" open onOpenChange={onOpenChange} />
      </TakerActionsProvider>
    </TooltipProvider>,
    makeDeps(),
  )
  return { actions, onOpenChange, user: userEvent.setup() }
}

const dialog = () => screen.getByRole('dialog', { name: '이슈 테이커 — App' })
const group = (i: number) => within(dialog()).getByRole('group', { name: `${i}단계` })
const groups = () => within(dialog()).queryAllByRole('group', { name: /^\d+단계$/ })
const enable = () => within(dialog()).getByRole('checkbox', { name: /^켜기/ })
const catchUp = () => within(dialog()).getByRole('checkbox', { name: /앱이 꺼진 동안 열린 이슈도 실행/ })
const save = () => within(dialog()).getByRole('button', { name: '저장' })
const addStep = () => within(dialog()).getByRole('button', { name: /단계 추가/ })
const commandOf = (i: number) => within(group(i)).getByLabelText('명령')
const promptOf = (i: number) => within(group(i)).getByLabelText('지시문')
const statusTexts = () => within(dialog()).queryAllByRole('status').map((s) => s.textContent ?? '')
const saved = () => useTakerStore.getState().repos[KEY]

beforeEach(() => {
  localStorage.removeItem(TAKER_STORAGE_KEY)
  useHostsStore.setState(useHostsStore.getInitialState(), true)
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online', me: { id: 'usr_x', githubLogin: 'me', avatarUrl: null } })
})
afterEach(() => {
  useTakerStore.setState({ repos: {}, taken: {}, runs: [], lastCheck: {} })
  localStorage.removeItem(TAKER_STORAGE_KEY)
})

describe('IssueTakerDialog — 처음 열 때', () => {
  it('AC-02 켜기 꺼짐, 작성자 "내가 쓴 이슈만", 꺼진 동안 꺼짐, 기본 2단계(Claude Code · ready-for-impl → --continue · start-workflow)', () => {
    setup()
    expect(enable()).not.toBeChecked()
    expect(within(dialog()).getByRole('radio', { name: /내가 쓴/ })).toBeChecked()
    expect(within(dialog()).getByRole('radio', { name: /쓰기 권한자/ })).not.toBeChecked()
    expect(within(dialog()).getByRole('radio', { name: /제한 없음/ })).not.toBeChecked()
    expect(catchUp()).not.toBeChecked()
    expect(groups()).toHaveLength(2)
    DEFAULT_STEPS.forEach((s, i) => {
      expect(within(group(i + 1)).getByRole('combobox')).toHaveDisplayValue('Claude Code')
      expect(commandOf(i + 1)).toHaveValue(s.command)
      expect(promptOf(i + 1)).toHaveValue(s.prompt)
    })
  })

  it('AC-02 대화상자에 설명(DialogDescription)이 있고, [저장] 이 아닌 버튼은 모두 type="button" 이다', () => {
    setup()
    expect(dialog()).toHaveAccessibleDescription(/\S/)
    const others = within(dialog())
      .getAllByRole('button')
      .filter((b) => b !== save())
    expect(others.length).toBeGreaterThan(0)
    expect(others.filter((b) => b.getAttribute('type') !== 'button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([])
  })
})

describe('IssueTakerDialog — 저장', () => {
  it('AC-03 켜고 [저장] 하면 이 저장소 설정이 켜짐으로 저장되고 owner·repo 는 원래 표기 그대로 남는다', async () => {
    const { user } = setup()
    await user.click(enable())
    await user.click(save())
    expect(saved()).toMatchObject({ enabled: true, owner: 'Acme', repo: 'App', author: 'me', catchUp: false, steps: DEFAULT_STEPS })
  })

  it.each([
    [/쓰기 권한자/, 'writers'],
    [/제한 없음/, 'anyone'],
    [/내가 쓴/, 'me'],
  ] as const)('AC-11 작성자 %s 를 고르고 저장하면 author=%s', async (label, author) => {
    const { user } = setup({ repos: { [KEY]: cfg({ author: author === 'me' ? 'anyone' : 'me' }) } })
    await user.click(within(dialog()).getByRole('radio', { name: label }))
    await user.click(save())
    expect(saved()?.author).toBe(author)
  })

  it('AC-12 "앱이 꺼진 동안 열린 이슈도 실행" 을 켜고 저장하면 catchUp=true', async () => {
    const { user } = setup({ repos: { [KEY]: cfg() } })
    expect(catchUp()).not.toBeChecked()
    await user.click(catchUp())
    await user.click(save())
    expect(saved()?.catchUp).toBe(true)
  })

  it('AC-13 켜져 있던 저장소는 켜기가 체크된 채 열리고, 끄고 저장하면 enabled=false', async () => {
    const { user } = setup({ repos: { [KEY]: cfg() } })
    expect(enable()).toBeChecked()
    await user.click(enable())
    await user.click(save())
    expect(saved()?.enabled).toBe(false)
  })
})

describe('IssueTakerDialog — 단계 편집', () => {
  it('AC-15 에이전트·명령·지시문을 고쳐 저장하면 그 단계에 저장된다', async () => {
    const { user } = setup({ repos: { [KEY]: cfg() } })
    await user.selectOptions(within(group(1)).getByRole('combobox'), 'Codex')
    await user.clear(commandOf(1))
    await user.type(commandOf(1), 'codex {{prompt}')
    await user.clear(promptOf(1))
    await user.type(promptOf(1), '/x {{number}')
    await user.click(save())
    expect(saved()?.steps).toEqual([{ kind: 'codex', command: 'codex {prompt}', prompt: '/x {number}' }, DEFAULT_STEPS[1]])
  })

  it('AC-15 [+ 단계 추가] 는 마지막에 단계를 더하고 포커스를 새 단계의 에이전트 선택으로 옮긴다', async () => {
    const { user } = setup()
    await user.click(addStep())
    expect(groups()).toHaveLength(3)
    expect(within(group(3)).getByRole('combobox')).toHaveFocus()
  })

  it('AC-15 단계마다 ↑·↓·삭제 버튼 이름에 단계 번호가 있다', () => {
    setup()
    for (const i of [1, 2]) {
      for (const action of ['위로', '아래로', '삭제']) expect(within(group(i)).getByRole('button', { name: `${i}단계 ${action}` })).toHaveAttribute('type', 'button')
    }
  })

  it('AC-15 삭제하면 그 단계가 빠지고 포커스는 다음 단계로, 삭제를 status 로 알린다', async () => {
    const { user } = setup()
    expect(statusTexts().some((t) => t.includes('단계'))).toBe(false)
    await user.click(within(group(1)).getByRole('button', { name: '1단계 삭제' }))
    expect(groups()).toHaveLength(1)
    expect(commandOf(1)).toHaveValue(DEFAULT_STEPS[1].command)
    expect(group(1)).toContainElement(document.activeElement as HTMLElement)
    expect(statusTexts().some((t) => t.includes('단계'))).toBe(true)
  })

  it('AC-15 마지막 단계를 지우면 포커스는 앞 단계로, 하나뿐인 단계를 지우면 [+ 단계 추가] 로 간다', async () => {
    const { user } = setup()
    await user.click(within(group(2)).getByRole('button', { name: '2단계 삭제' }))
    expect(group(1)).toContainElement(document.activeElement as HTMLElement)
    await user.click(within(group(1)).getByRole('button', { name: '1단계 삭제' }))
    expect(groups()).toHaveLength(0)
    expect(addStep()).toHaveFocus()
  })

  it('AC-15 ↑ 으로 옮기면 순서가 바뀌고, 옮긴 단계가 맨 앞이 되면 포커스는 그 단계의 ↓ 로 간다(이동을 status 로 알림)', async () => {
    const { user } = setup()
    await user.click(within(group(2)).getByRole('button', { name: '2단계 위로' }))
    expect(commandOf(1)).toHaveValue(DEFAULT_STEPS[1].command)
    expect(commandOf(2)).toHaveValue(DEFAULT_STEPS[0].command)
    expect(within(group(1)).getByRole('button', { name: '1단계 아래로' })).toHaveFocus()
    expect(statusTexts().some((t) => t.includes('단계'))).toBe(true)
  })

  it('AC-15 ↓ 으로 가운데로 옮기면 포커스는 옮긴 단계의 같은 ↓ 버튼에 남는다', async () => {
    const { user } = setup()
    await user.click(addStep())
    await user.click(within(group(1)).getByRole('button', { name: '1단계 아래로' }))
    expect(commandOf(2)).toHaveValue(DEFAULT_STEPS[0].command)
    expect(within(group(2)).getByRole('button', { name: '2단계 아래로' })).toHaveFocus()
  })
})

describe('IssueTakerDialog — 검사·경고', () => {
  it('EC-08 권한 확인을 건너뛰는 옵션이 있으면 그 단계에 "사람 확인 없이 명령을 실행합니다" 경고(명령 입력의 설명), 저장은 된다', async () => {
    const { user } = setup({ repos: { [KEY]: cfg() } })
    await user.clear(commandOf(1))
    await user.type(commandOf(1), 'claude --dangerously-skip-permissions {{prompt}')
    expect(within(group(1)).getByText(/사람 확인 없이 명령을 실행합니다/)).toBeInTheDocument()
    expect(commandOf(1)).toHaveAccessibleDescription(/사람 확인 없이 명령을 실행합니다/)
    expect(within(group(2)).queryByText(/사람 확인 없이 명령을 실행합니다/)).toBeNull()
    expect(save()).toBeEnabled()
    await user.click(save())
    expect(saved()?.steps[0].command).toBe('claude --dangerously-skip-permissions {prompt}')
  })

  it.each([
    ['빈 명령', ''],
    ['{prompt} 없이 지시문', 'claude'],
    ['{prompt} 를 따옴표로 감쌈', "claude '{{prompt}'"],
  ])('EC-09 %s → 명령 입력 aria-invalid + buildCommand 오류 문구, [저장] 비활성과 사유', async (_label, typed) => {
    const { user } = setup({ repos: { [KEY]: cfg() } })
    await user.clear(commandOf(1))
    if (typed !== '') await user.type(commandOf(1), typed)
    const built = buildCommand((commandOf(1) as HTMLInputElement).value, DEFAULT_STEPS[0].prompt, 'posix')
    expect(built.ok).toBe(false)
    expect(commandOf(1)).toHaveAttribute('aria-invalid', 'true')
    expect(within(group(1)).getByText(built.ok ? '' : built.error)).toBeInTheDocument()
    expect(save()).toBeDisabled()
    expect(save()).toHaveAccessibleDescription(/\S/)
  })

  it.each(['{{title} 고쳐', '-p 고쳐'])('EC-27 지시문 틀이 {title} 이나 - 로 시작하면(%s) 그 단계에 오류, [저장] 비활성', async (typed) => {
    const { user } = setup({ repos: { [KEY]: cfg() } })
    await user.clear(promptOf(1))
    await user.type(promptOf(1), typed)
    expect([commandOf(1), promptOf(1)].some((el) => el.getAttribute('aria-invalid') === 'true')).toBe(true)
    expect(within(group(1)).getByRole('alert')).toHaveTextContent(/\S/)
    expect(save()).toBeDisabled()
  })

  it('EC-10 단계를 모두 지우면 "단계를 하나 이상 두세요", [저장] 비활성', async () => {
    const { user } = setup({ repos: { [KEY]: cfg() } })
    await user.click(within(group(2)).getByRole('button', { name: '2단계 삭제' }))
    await user.click(within(group(1)).getByRole('button', { name: '1단계 삭제' }))
    expect(within(dialog()).getByText('단계를 하나 이상 두세요')).toBeInTheDocument()
    expect(save()).toBeDisabled()
  })
})

describe('IssueTakerDialog — 안내', () => {
  it('EC-07 연결 호스트가 tmux 를 쓰지 않는 원격이면 1단계만 자동이고 [다음 단계] 로 진행한다고 안내한다(이 PC 면 없음)', () => {
    useHostsStore.setState({
      aliases: ['srv'],
      useTmux: true,
      repoHosts: { [KEY]: 'ssh:srv' },
      probes: { srv: { platform: 'linux', home: '/home/dev', git: 'git version 2.43.0', tmux: false } },
    })
    setup()
    const note = within(dialog()).getByText(/tmux/)
    expect(note).toHaveTextContent(/다음 단계/)
  })

  it('EC-07 이 PC 에서 여는 저장소에는 tmux 안내가 없다', () => {
    setup()
    expect(enable()).toBeInTheDocument()
    expect(within(dialog()).queryByText(/tmux/)).toBeNull()
  })

  it('EC-07 tmux 사용을 끈 원격은 연결 전에도 안내한다', () => {
    useHostsStore.setState({ aliases: ['srv'], useTmux: false, repoHosts: { [KEY]: 'ssh:srv' }, probes: {} })
    setup()
    const note = within(dialog()).getByText(/tmux/)
    expect(note).toHaveTextContent(/다음 단계/)
  })

  it('EC-07 tmux 사용을 켠 원격은 연결을 확인하기 전에는 안내하지 않는다', () => {
    useHostsStore.setState({ aliases: ['srv'], useTmux: true, repoHosts: { [KEY]: 'ssh:srv' }, probes: {} })
    setup()
    expect(enable()).toBeInTheDocument()
    expect(within(dialog()).queryByText(/tmux/)).toBeNull()
  })

  it('A-25 셸에 남은 프로그램이 있으면 [자동 실행 멈춤] 으로 푼다고 안내한다', () => {
    setup()
    const note = within(dialog()).getByText(/자동 실행 멈춤/)
    expect(note).toHaveTextContent(/백그라운드/)
    expect(note).toHaveTextContent(/개발 서버/)
    expect(note).toHaveTextContent(/명령이 들어가지 않/)
    expect(note).toHaveTextContent(/다음 단계로 넘어가지 않/)
  })

  it('EC-17 같은 계정의 다른 PC 에서도 켜면 두 PC 가 모두 실행할 수 있다고 안내한다', () => {
    setup()
    expect(within(dialog()).getByText(/(다른|두|여러) PC/)).toBeInTheDocument()
  })

  it('EC-21 --continue 는 그 폴더의 마지막 대화를 잇는다고 안내한다', () => {
    setup()
    expect(within(dialog()).getByText(/--continue/)).toHaveTextContent(/마지막 대화/)
  })
})

describe('IssueTakerDialog — 실행 목록과 마지막 확인', () => {
  it('AC-10 그 저장소의 실행(이슈·단계·상태·버튼)과 "실행 중 {k}/3" 을 보인다 — 다른 저장소의 실행은 없다', async () => {
    const { actions, user } = setup({
      repos: { [KEY]: cfg() },
      runs: [
        runOf(120, 'running', { title: '로그인 수정' }),
        runOf(119, 'failed', { error: '에이전트가 시작되지 않음' }),
        runOf(118, 'done', { step: 1 }),
        runOf(5, 'done', { repoKey: 'acme/web', repo: 'web', issueId: 'acme/web#5', title: '다른 저장소' }),
      ],
    })
    const items = within(dialog())
      .getAllByRole('listitem')
      .filter((li) => /#\d+/.test(li.textContent ?? ''))
    expect(items).toHaveLength(3)
    const running = items.find((li) => li.textContent?.includes('#120'))!
    expect(running).toHaveTextContent('로그인 수정')
    expect(running).toHaveTextContent('1/2 단계')
    expect(running).toHaveTextContent('실행 중')
    expect(within(dialog()).queryByText(/다른 저장소/)).toBeNull()
    expect(within(dialog()).getByText(/실행 중 1\/3/)).toBeInTheDocument()
    await user.click(within(running).getByRole('button', { name: '#120 멈춤' }))
    expect(actions.stop).toHaveBeenCalledWith('r120')
    const failed = items.find((li) => li.textContent?.includes('#119'))!
    expect(failed).toHaveTextContent('에이전트가 시작되지 않음')
    await user.click(within(failed).getByRole('button', { name: /#119 .*다시/ }))
    expect(actions.restart).toHaveBeenCalledWith('r119')
  })

  it('AC-10 실행이 없으면 "아직 자동 실행한 이슈가 없습니다", 확인 전이면 "마지막 확인: 아직 없음"', () => {
    setup({ repos: { [KEY]: cfg() } })
    expect(within(dialog()).getByText('아직 자동 실행한 이슈가 없습니다')).toBeInTheDocument()
    expect(within(dialog()).getByText('마지막 확인: 아직 없음')).toBeInTheDocument()
  })

  it('A-19 실행 목록의 다음 단계 대기 실행에 "#{n} 이 단계부터 다시" 가 있다', async () => {
    const { actions, user } = setup({ repos: { [KEY]: cfg() }, runs: [runOf(120, 'manualNext')] })
    const item = within(dialog())
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes('#120'))!
    expect(within(item).getByRole('button', { name: '#120 다음 단계' })).toBeInTheDocument()
    await user.click(within(item).getByRole('button', { name: '#120 이 단계부터 다시' }))
    expect(actions.restart).toHaveBeenCalledWith('r120')
    expect(actions.nextStep).not.toHaveBeenCalled()
  })

  it('AC-10 마지막 확인이 2분 전이면 "마지막 확인: 2분 전"', () => {
    setup({ repos: { [KEY]: cfg() }, lastCheck: { [KEY]: { at: Date.now() - 2 * 60_000 - 1_000, error: null } } })
    expect(within(dialog()).getByText('마지막 확인: 2분 전')).toBeInTheDocument()
  })

  it('AC-10 마지막 확인이 실패했으면 "마지막 확인 실패: {사유}"', () => {
    setup({ repos: { [KEY]: cfg() }, lastCheck: { [KEY]: { at: Date.now() - 60_000, error: 'GitHub 오류(rate_limited)' } } })
    expect(within(dialog()).getByText(/마지막 확인 실패: GitHub 오류\(rate_limited\)/)).toBeInTheDocument()
  })
})
