// E2E 큐 화면(#92) — 작업 목록·버튼, 역할 설정(CLI·모델·지시문), 상단 버튼의 수·"확인 필요"
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '../../components/ui/tooltip'
import { useUiStore } from '../../store/ui'
import { createFakeTauri, deferred } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { isLaunchPending, queueLaunch } from '../agents/launchQueue'
import { E2eQueueButton } from './E2eQueueButton'
import { E2eQueueDialog } from './E2eQueueDialog'
import { useE2eQueueStore } from './queueStore'
import type { E2eJob } from './queueStore'
import { DEFAULT_ROLES } from './roles'

const ISSUE = 'acme/app#42'
const PANE_1 = `${ISSUE}::1`
const PANE_2 = `${ISSUE}::2`

const job = (over: Partial<E2eJob> & Pick<E2eJob, 'id'>): E2eJob => ({
  issueId: ISSUE,
  title: 'app #42 Add login',
  status: 'queued',
  stage: 0,
  panes: [null, null, null],
  ...over,
})

const CODEX_RAW = JSON.stringify({
  models: [
    { slug: 'gpt-5.1-codex', display_name: 'GPT-5.1 Codex', visibility: 'list', priority: 1 },
    { slug: 'gpt-5.1-codex-mini', display_name: 'GPT-5.1 Codex Mini', visibility: 'list', priority: 2 },
  ],
})

beforeEach(() => {
  localStorage.clear()
  useE2eQueueStore.setState({ jobs: [] })
  useUiStore.setState({
    e2eRoles: DEFAULT_ROLES,
    selectedIssueId: ISSUE,
    tab: 'notes',
    panes: {
      [ISSUE]: {
        tree: { kind: 'split', dir: 'row', a: { kind: 'leaf', id: PANE_1 }, b: { kind: 'leaf', id: PANE_2 } },
        focused: PANE_1,
        seq: 2,
        first: PANE_1,
      },
    },
  })
})

function renderDialog(agentModelsRaw: (kind: string) => Promise<string> = async () => '') {
  const { tauri } = createFakeTauri({ agentModelsRaw })
  const onOpenChange = vi.fn()
  renderWithDeps(
    <TooltipProvider>
      <E2eQueueDialog open onOpenChange={onOpenChange} />
    </TooltipProvider>,
    makeDeps({ tauri }),
  )
  return { user: userEvent.setup(), onOpenChange, tauri }
}

const jobRow = (i = 0) => screen.getAllByTestId('e2e-job')[i]

describe('작업 탭', () => {
  it('AC-12 작업마다 이슈 이름과 상태(대기·실행 중 n/3 단계명·완료·실패 사유·취소)를 보인다', () => {
    useE2eQueueStore.setState({
      jobs: [
        job({ id: 'a', status: 'running', stage: 1, panes: [PANE_1, PANE_2, null] }),
        job({ id: 'b', issueId: 'acme/app#7', title: 'app #7 Fix', status: 'queued' }),
        job({ id: 'c', issueId: 'acme/app#8', title: 'app #8 Done', status: 'done' }),
        job({ id: 'd', issueId: 'acme/app#9', title: 'app #9 Bad', status: 'failed', error: '작업 폴더가 열려 있지 않습니다' }),
        job({ id: 'e', issueId: 'acme/app#10', title: 'app #10 Stop', status: 'cancelled' }),
      ],
    })
    renderDialog()
    const statuses = screen.getAllByTestId('e2e-job-status').map((e) => e.textContent)
    expect(statuses).toEqual(['실행 중 2/3 ② 엣지케이스 찾기', '대기', '완료', '실패 — 작업 폴더가 열려 있지 않습니다', '취소'])
    expect(jobRow(0)).toHaveTextContent('app #42 Add login')
    // 상태 영역은 바뀌면 읽어 준다
    expect(screen.getByRole('list', { name: 'E2E 큐 작업' }).parentElement).toHaveAttribute('aria-live', 'polite')
  })

  it('EC-23 실행 중 작업의 확인 필요 문구(attention·exited·undetected·unknown)를 작업 행에 보인다', () => {
    useE2eQueueStore.setState({ jobs: [job({ id: 'a', status: 'running', panes: [PANE_1, null, null], notice: 'exited' })] })
    renderDialog()
    expect(screen.getByTestId('e2e-job-notice')).toHaveTextContent('에이전트가 종료됨 — 결과를 보고 [다음 단계]로 넘기세요')
    act(() => useE2eQueueStore.getState().setNotice('a', 0, 'unknown'))
    expect(screen.getByTestId('e2e-job-notice')).toHaveTextContent('에이전트 상태를 확인할 수 없음 — 패널을 보세요(ssh 인증 등)')
    act(() => useE2eQueueStore.getState().setNotice('a', 0, undefined))
    expect(screen.queryByTestId('e2e-job-notice')).toBeNull()
  })

  it('AC-06 [다음 단계]는 실행 중 작업의 현재 단계를 넘긴다 — 버튼 이름에 이슈가 들어간다', async () => {
    useE2eQueueStore.setState({ jobs: [job({ id: 'a', status: 'running', panes: [PANE_1, null, null] })] })
    const { user } = renderDialog()
    await user.click(screen.getByRole('button', { name: '다음 단계 (app #42 Add login)' }))
    expect(useE2eQueueStore.getState().jobs[0]).toMatchObject({ status: 'running', stage: 1 })
  })

  it('AC-07 [취소]는 대기·실행 중 작업을 취소하고 아직 입력되지 않은 명령을 지운다', async () => {
    useE2eQueueStore.setState({
      jobs: [
        job({ id: 'a', status: 'running', panes: [PANE_2, null, null] }),
        job({ id: 'b', issueId: 'acme/app#7', title: 'app #7 Fix' }),
      ],
    })
    queueLaunch(PANE_2, 'claude x')
    const { user } = renderDialog()
    await user.click(screen.getByRole('button', { name: '취소 (app #42 Add login)' }))
    await user.click(screen.getByRole('button', { name: '취소 (app #7 Fix)' }))
    expect(useE2eQueueStore.getState().jobs.map((j) => j.status)).toEqual(['cancelled', 'cancelled'])
    expect(isLaunchPending(PANE_2)).toBe(false)
    // 끝난 작업에는 [다음 단계]·[취소] 가 없다
    expect(screen.queryByRole('button', { name: /^다음 단계/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^취소/ })).toBeNull()
  })

  it('AC-08 [다시 실행]은 끝난 작업을 새 대기 작업으로 넣고, [목록에서 지우기]는 끝난 작업을 없앤다', async () => {
    useE2eQueueStore.setState({ jobs: [job({ id: 'a', status: 'failed', error: 'x' })] })
    const { user } = renderDialog()
    await user.click(screen.getByRole('button', { name: '다시 실행 (app #42 Add login)' }))
    const jobs = useE2eQueueStore.getState().jobs
    expect(jobs).toHaveLength(2)
    expect(jobs[1]).toMatchObject({ issueId: ISSUE, status: 'queued' })
    expect(jobs[1].id).not.toBe('a')
    await user.click(screen.getByRole('button', { name: '목록에서 지우기 (app #42 Add login)' }))
    expect(useE2eQueueStore.getState().jobs.map((j) => j.id)).toEqual([jobs[1].id])
  })

  // L-1 (EC-04)
  it('L-1 [다시 실행] 때 같은 이슈가 이미 대기·실행 중이면 넣지 않고 그 행에 안내한다(role=status)', async () => {
    useE2eQueueStore.setState({ jobs: [job({ id: 'a', status: 'failed', error: 'x' }), job({ id: 'b', status: 'queued' })] })
    const { user } = renderDialog()
    const row = jobRow(0)
    expect(within(row).getByRole('status')).toBeEmptyDOMElement()
    await user.click(within(row).getByRole('button', { name: '다시 실행 (app #42 Add login)' }))
    expect(useE2eQueueStore.getState().jobs.map((j) => j.id)).toEqual(['a', 'b'])
    expect(within(row).getByRole('status')).toHaveTextContent('이미 E2E 큐에서 대기·실행 중입니다')
  })

  it('AC-09 [패널로 이동]은 그 이슈의 터미널 탭에서 단계 패널을 고르고 대화상자를 닫는다', async () => {
    useUiStore.setState({ selectedIssueId: 'acme/app#7' })
    useE2eQueueStore.setState({ jobs: [job({ id: 'a', status: 'running', stage: 1, panes: [PANE_1, PANE_2, null] })] })
    const { user, onOpenChange } = renderDialog()
    await user.click(screen.getByRole('button', { name: '패널로 이동 (app #42 Add login)' }))
    const ui = useUiStore.getState()
    expect(ui.selectedIssueId).toBe(ISSUE)
    expect(ui.tab).toBe('terminal')
    expect(ui.panes[ISSUE].focused).toBe(PANE_2)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('A-10 이슈를 하나도 열지 않았으면 단계가 시작되지 않는다고 안내한다', () => {
    useUiStore.setState({ selectedIssueId: null })
    renderDialog()
    expect(screen.getByTestId('e2e-no-issue')).toHaveTextContent('이슈를 하나 고르지 않으면 단계가 시작되지 않습니다')
  })
})

describe('Phase 8 접근성 회귀 — 누른 버튼이 사라져도 포커스를 잃지 않는다(WCAG 2.4.3)', () => {
  it('[취소] 뒤에는 같은 행의 [다시 실행]으로 포커스가 간다', async () => {
    useE2eQueueStore.setState({ jobs: [job({ id: 'a', status: 'queued' })] })
    const { user } = renderDialog()
    await user.click(screen.getByRole('button', { name: '취소 (app #42 Add login)' }))
    expect(screen.getByRole('button', { name: '다시 실행 (app #42 Add login)' })).toHaveFocus()
  })

  it('③에서 [다음 단계]로 완료되면 같은 행의 [다시 실행]으로, 단계만 넘어가면 [다음 단계]에 그대로 둔다', async () => {
    useE2eQueueStore.setState({ jobs: [job({ id: 'a', status: 'running', stage: 1, panes: [PANE_1, PANE_2, null] })] })
    const { user } = renderDialog()
    const next = screen.getByRole('button', { name: '다음 단계 (app #42 Add login)' })
    await user.click(next)
    expect(next).toHaveFocus()
    await user.click(next)
    expect(useE2eQueueStore.getState().jobs[0].status).toBe('done')
    expect(screen.getByRole('button', { name: '다시 실행 (app #42 Add login)' })).toHaveFocus()
  })

  it('[목록에서 지우기] 뒤에는 다음 행(없으면 이전 행)의 첫 버튼, 모두 지우면 빈 안내로 포커스가 간다', async () => {
    useE2eQueueStore.setState({
      jobs: [
        job({ id: 'a', status: 'done' }),
        job({ id: 'b', issueId: 'acme/app#7', title: 'app #7 Fix', status: 'failed', error: 'x' }),
        job({ id: 'c', issueId: 'acme/app#8', title: 'app #8 Stop', status: 'cancelled' }),
      ],
    })
    const { user } = renderDialog()
    await user.click(screen.getByRole('button', { name: '목록에서 지우기 (app #7 Fix)' }))
    expect(screen.getByRole('button', { name: '다시 실행 (app #8 Stop)' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: '목록에서 지우기 (app #8 Stop)' }))
    expect(screen.getByRole('button', { name: '다시 실행 (app #42 Add login)' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: '목록에서 지우기 (app #42 Add login)' }))
    expect(screen.getByText(/큐가 비어 있습니다/)).toHaveFocus()
  })

  it('[다시 실행] 중복 안내는 4초 뒤 지운다', () => {
    vi.useFakeTimers()
    try {
      useE2eQueueStore.setState({ jobs: [job({ id: 'a', status: 'failed', error: 'x' }), job({ id: 'b', status: 'queued' })] })
      renderDialog()
      const row = jobRow(0)
      fireEvent.click(within(row).getByRole('button', { name: '다시 실행 (app #42 Add login)' }))
      expect(within(row).getByRole('status')).toHaveTextContent('이미 E2E 큐에서 대기·실행 중입니다')
      act(() => vi.advanceTimersByTime(3900))
      expect(within(row).getByRole('status')).toHaveTextContent('이미 E2E 큐에서 대기·실행 중입니다')
      act(() => vi.advanceTimersByTime(100))
      expect(within(row).getByRole('status')).toBeEmptyDOMElement()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('역할 설정 탭', () => {
  async function openRoles(agentModelsRaw?: (kind: string) => Promise<string>) {
    const r = renderDialog(agentModelsRaw)
    await r.user.click(screen.getByRole('tab', { name: '역할 설정' }))
    return r
  }
  const role = (name: string) => screen.getByRole('group', { name })

  it('AC-10 역할마다 CLI·지시문을 고르면 ui store 에 저장한다 — CLI 를 바꾸면 모델은 기본값, [기본값]은 지시문을 되돌린다', async () => {
    useUiStore.getState().setE2eRole('edge', { ...DEFAULT_ROLES.edge, model: 'opus' })
    const { user } = await openRoles()
    expect(screen.getAllByRole('group').map((g) => g.querySelector('legend')?.textContent)).toEqual([
      '① E2E 실행',
      '② 엣지케이스 찾기',
      '③ 엣지케이스 기반 테스트',
    ])
    const edge = role('② 엣지케이스 찾기')
    await user.click(within(edge).getByRole('radio', { name: 'Codex' }))
    expect(useUiStore.getState().e2eRoles.edge).toMatchObject({ kind: 'codex', model: '' })
    expect(within(edge).getByRole('radiogroup', { name: '② 엣지케이스 찾기 CLI' })).toBeInTheDocument()

    const prompt = within(edge).getByLabelText('지시문')
    await user.clear(prompt)
    await user.type(prompt, '새 지시문 {{out}')
    expect(useUiStore.getState().e2eRoles.edge.prompt).toBe('새 지시문 {out}')
    await user.click(within(edge).getByRole('button', { name: '기본값' }))
    expect(useUiStore.getState().e2eRoles.edge.prompt).toBe(DEFAULT_ROLES.edge.prompt)
    expect(within(edge).queryByRole('button', { name: '기본값' })).toBeNull()
    // 다른 역할은 그대로
    expect(useUiStore.getState().e2eRoles.run).toEqual(DEFAULT_ROLES.run)
  })

  it('AC-11 고른 CLI 의 모델 목록을 호스트에서 받아 선택지로 보이고, 고르면 저장한다 — [새로 고침]은 다시 받는다', async () => {
    useUiStore.getState().setE2eRole('run', { ...DEFAULT_ROLES.run, kind: 'codex' })
    const raw = vi.fn(async (kind: string) => (kind === 'codex' ? CODEX_RAW : ''))
    const { user } = await openRoles(raw)
    expect(screen.getByTestId('e2e-models-source')).toHaveTextContent('목록 출처: 이 PC')
    const run = role('① E2E 실행')
    await waitFor(() => expect(within(run).getByRole('status')).toHaveTextContent('모델 2개'))
    const select = within(run).getByLabelText('모델')
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      '기본값(CLI 설정)',
      'GPT-5.1 Codex (gpt-5.1-codex)',
      'GPT-5.1 Codex Mini (gpt-5.1-codex-mini)',
      '직접 입력…',
    ])
    await user.selectOptions(select, 'gpt-5.1-codex-mini')
    expect(useUiStore.getState().e2eRoles.run.model).toBe('gpt-5.1-codex-mini')
    expect(raw).toHaveBeenCalledWith('codex')

    const calls = raw.mock.calls.length
    await user.click(within(run).getByRole('button', { name: '모델 목록 새로 고침' }))
    await waitFor(() => expect(raw.mock.calls.length).toBe(calls + 1))
  })

  it('AC-11 목록을 받는 동안 불러오는 중을 상태로 알린다', async () => {
    const d = deferred<string>()
    await openRoles(() => d.promise)
    expect(within(role('① E2E 실행')).getByRole('status')).toHaveTextContent('모델 목록을 불러오는 중…')
    await act(async () => d.resolve(''))
    // claude 캐시가 없으면 별칭
    await waitFor(() => expect(within(role('① E2E 실행')).getByRole('status')).toHaveTextContent('모델 3개'))
  })

  it('EC-06 모델 목록을 받지 못하면 오류 문구를 보이고 직접 입력할 수 있다', async () => {
    useUiStore.getState().setE2eRole('run', { ...DEFAULT_ROLES.run, kind: 'gemini' })
    const { user } = await openRoles(async (kind) => {
      if (kind === 'gemini') throw new Error('gemini 를 찾지 못했습니다')
      return ''
    })
    const run = role('① E2E 실행')
    await waitFor(() =>
      expect(within(run).getByRole('status')).toHaveTextContent(
        '모델 목록을 불러오지 못했습니다: gemini 를 찾지 못했습니다 — 모델 이름을 직접 입력할 수 있습니다',
      ),
    )
    await user.selectOptions(within(run).getByLabelText('모델'), '직접 입력…')
    await user.type(within(run).getByLabelText('모델 이름'), 'gemini-2.5-pro')
    expect(useUiStore.getState().e2eRoles.run.model).toBe('gemini-2.5-pro')
  })

  it('EC-05 직접 입력한 모델이 패턴에 맞지 않으면 aria-invalid·오류 문구로 알리고 저장하지 않는다', async () => {
    const { user } = await openRoles()
    const run = role('① E2E 실행')
    await waitFor(() => expect(within(run).getByRole('status')).toHaveTextContent('모델 3개'))
    await user.selectOptions(within(run).getByLabelText('모델'), '직접 입력…')
    const input = within(run).getByLabelText('모델 이름')
    expect(input).not.toHaveAttribute('aria-invalid')

    await user.type(input, 'opus; rm')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription(/저장하지 않았습니다/)
    expect(useUiStore.getState().e2eRoles.run.model).toBe('opus')

    await user.clear(input)
    await user.type(input, '--dangerously')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(useUiStore.getState().e2eRoles.run.model).toBe('opus')

    await user.clear(input)
    await user.type(input, 'claude-opus-4-1[[1m]')
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(useUiStore.getState().e2eRoles.run.model).toBe('claude-opus-4-1[1m]')

    // 기본값으로 돌리면 모델 인자를 넣지 않는다
    await user.selectOptions(within(run).getByLabelText('모델'), '기본값(CLI 설정)')
    expect(useUiStore.getState().e2eRoles.run.model).toBe('')
    expect(within(run).queryByLabelText('모델 이름')).toBeNull()
  })

  // L-5 (EC-05)
  it('L-5 모델 이름 패턴에 맞지 않는 목록 항목은 선택지에서 뺀다 — 저장할 수 없는 값을 고르지 못하게', async () => {
    useUiStore.getState().setE2eRole('run', { ...DEFAULT_ROLES.run, kind: 'codex' })
    const raw = JSON.stringify({
      models: [
        { slug: 'gpt-5.1-codex', display_name: 'GPT-5.1 Codex', visibility: 'list', priority: 1 },
        { slug: '--yolo', display_name: 'Bad', visibility: 'list', priority: 2 },
        { slug: 'bad model;rm', display_name: 'Bad 2', visibility: 'list', priority: 3 },
      ],
    })
    await openRoles(async (kind) => (kind === 'codex' ? raw : ''))
    const run = role('① E2E 실행')
    await waitFor(() => expect(within(run).getByRole('status')).toHaveTextContent('모델 1개'))
    const select = within(run).getByLabelText('모델')
    expect([...select.querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'gpt-5.1-codex', '__custom__'])
  })

  it('AC-10 저장한 모델이 목록에 없으면 직접 입력 칸에 그 값을 보인다', async () => {
    useUiStore.getState().setE2eRole('run', { ...DEFAULT_ROLES.run, model: 'claude-custom-1' })
    await openRoles()
    const run = role('① E2E 실행')
    await waitFor(() => expect(within(run).getByLabelText('모델 이름')).toHaveValue('claude-custom-1'))
    expect(within(run).getByLabelText('모델')).toHaveValue('__custom__')
  })
})

describe('Phase 8 접근성 회귀 — 역할 설정', () => {
  async function openRoles(agentModelsRaw?: (kind: string) => Promise<string>) {
    const r = renderDialog(agentModelsRaw)
    await r.user.click(screen.getByRole('tab', { name: '역할 설정' }))
    return r
  }
  const role = (name: string) => screen.getByRole('group', { name })

  it('[기본값]을 누르면 버튼이 사라지므로 그 역할의 지시문으로 포커스가 간다', async () => {
    useUiStore.getState().setE2eRole('edge', { ...DEFAULT_ROLES.edge, prompt: '바꾼 지시문' })
    const { user } = await openRoles()
    const edge = role('② 엣지케이스 찾기')
    await user.click(within(edge).getByRole('button', { name: '기본값' }))
    expect(within(edge).getByLabelText('지시문')).toHaveFocus()
  })

  it('모델 목록 상태는 select 의 설명이고, 받는 동안 [새로 고침]은 aria-disabled 로 포커스를 유지하며 눌러도 다시 받지 않는다', async () => {
    let d = deferred<string>()
    const raw = vi.fn(() => d.promise)
    const { user } = await openRoles(raw)
    const run = role('① E2E 실행')
    expect(within(run).getByLabelText('모델')).toHaveAccessibleDescription('모델 목록을 불러오는 중…')
    await waitFor(() => expect(raw).toHaveBeenCalled())
    const calls = raw.mock.calls.length
    const refresh = within(run).getByRole('button', { name: '모델 목록 새로 고침' })
    expect(refresh).toHaveAttribute('aria-disabled', 'true')
    expect(refresh).not.toBeDisabled()
    await user.click(refresh)
    expect(refresh).toHaveFocus()
    expect(raw).toHaveBeenCalledTimes(calls)
    const first = d
    d = deferred<string>()
    await act(async () => first.resolve(''))
    await waitFor(() => expect(within(run).getByLabelText('모델')).toHaveAccessibleDescription('모델 3개'))
    expect(refresh).not.toHaveAttribute('aria-disabled')
  })

  it('모델 목록 오류는 바로 읽히고(assertive), 직접 입력 오류는 role=alert 로 알린다', async () => {
    useUiStore.getState().setE2eRole('run', { ...DEFAULT_ROLES.run, kind: 'gemini' })
    const { user } = await openRoles(async (kind) => {
      if (kind === 'gemini') throw new Error('없음')
      return ''
    })
    const run = role('① E2E 실행')
    await waitFor(() => expect(within(run).getByRole('status')).toHaveAttribute('aria-live', 'assertive'))
    await user.selectOptions(within(run).getByLabelText('모델'), '직접 입력…')
    await user.type(within(run).getByLabelText('모델 이름'), '--x')
    expect(within(run).getByRole('alert')).toHaveTextContent('저장하지 않았습니다')
  })
})

describe('상단 [E2E 큐] 버튼', () => {
  function renderButton() {
    const onClick = vi.fn()
    renderWithDeps(
      <TooltipProvider>
        <E2eQueueButton onClick={onClick} />
      </TooltipProvider>,
      makeDeps(),
    )
    return { onClick, button: () => screen.getByTestId('e2e-queue-button') }
  }

  it('AC-12 대기+실행 중 작업 수를 버튼 이름과 배지에 보인다 — 끝난 작업은 세지 않는다', async () => {
    const { onClick, button } = renderButton()
    expect(button()).toHaveAccessibleName('E2E 큐')
    act(() =>
      useE2eQueueStore.setState({
        jobs: [
          job({ id: 'a', status: 'running', panes: [PANE_1, null, null] }),
          job({ id: 'b', issueId: 'x#1' }),
          job({ id: 'c', issueId: 'x#2', status: 'done' }),
        ],
      }),
    )
    expect(button()).toHaveAccessibleName('E2E 큐 (2)')
    await userEvent.setup().click(button())
    expect(onClick).toHaveBeenCalled()
  })

  it('EC-23 실행 중 작업이 확인 필요(attention·exited·unknown)면 버튼 이름에 "확인 필요"를 넣고 강조한다 — undetected 는 아니다', () => {
    useE2eQueueStore.setState({ jobs: [job({ id: 'a', status: 'running', panes: [PANE_1, null, null], notice: 'undetected' })] })
    const { button } = renderButton()
    expect(button()).toHaveAccessibleName('E2E 큐 (1)')
    expect(button()).not.toHaveAttribute('data-attention')
    for (const notice of ['attention', 'exited', 'unknown'] as const) {
      act(() => useE2eQueueStore.getState().setNotice('a', 0, notice))
      expect(button()).toHaveAccessibleName('E2E 큐 (1) — 확인 필요')
      expect(button()).toHaveAttribute('data-attention', 'true')
    }
    act(() => useE2eQueueStore.getState().setNotice('a', 0, undefined))
    expect(button()).toHaveAccessibleName('E2E 큐 (1)')
  })
})

describe('Phase 11 결정 — 결과 파일 없음 안내(L-4·EC-25)', () => {
  it('L-4 nofile 이면 작업 행에 "결과 파일이 아직 없음 — 패널을 보세요"를 보이고 상단 버튼을 확인 필요로 강조한다', () => {
    useE2eQueueStore.setState({ jobs: [job({ id: 'a', status: 'running', panes: [PANE_1, null, null], notice: 'nofile' })] })
    renderDialog()
    renderWithDeps(
      <TooltipProvider>
        <E2eQueueButton onClick={vi.fn()} />
      </TooltipProvider>,
      makeDeps(),
    )
    expect(screen.getByTestId('e2e-job-notice')).toHaveTextContent('결과 파일이 아직 없음 — 패널을 보세요')
    const button = screen.getByTestId('e2e-queue-button')
    expect(button).toHaveAccessibleName('E2E 큐 (1) — 확인 필요')
    expect(button).toHaveAttribute('data-attention', 'true')
    act(() => useE2eQueueStore.getState().setNotice('a', 0, undefined))
    expect(screen.queryByTestId('e2e-job-notice')).toBeNull()
    expect(button).not.toHaveAttribute('data-attention')
  })
})
