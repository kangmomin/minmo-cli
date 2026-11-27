// 이슈 머리줄의 수정·닫기(#64) — GitHub 이슈(제목·본문 수정, 이유를 골라 닫기)와 로컬 작업(제목 수정, 바로 닫기)
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { GitHubError, worktreeId } from '@minmo/core'
import type { GitHubClient, GitHubIssue, IssueTarget } from '@minmo/core'

import { TooltipProvider } from '../../components/ui/tooltip'
import { queryKeys } from '../../lib/queryKeys'
import { LOCAL_OWNER, useReposStore } from '../../store/repos'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeGitHub } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { IssueHeader } from './IssueHeader'
import { IssueTab } from './IssueTab'
import { WorktreeProvider } from './useWorktree'

const GH: IssueTarget = { owner: 'my-org', repo: 'widgets', key: '42', number: 42, title: 'Add login' }
const GH_ID = worktreeId('my-org', 'widgets', '42')
const ISSUE_42: GitHubIssue = { number: 42, title: 'Add login', state: 'open', htmlUrl: 'https://github.com/my-org/widgets/issues/42', assignees: [] }

const TASK_REPO = 'app-1a2b'
const TASK: IssueTarget = { owner: LOCAL_OWNER, repo: TASK_REPO, key: '1', number: 1, title: '첫 작업' }
const TASK_ID = worktreeId(LOCAL_OWNER, TASK_REPO, '1')

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
  useUiStore.setState({ worktreePathMap: {}, terminalIds: {}, launchRequest: null })
  useSetupStore.setState({ targets: { [GH_ID]: GH, [TASK_ID]: TASK }, open: {}, script: {}, logs: {} })
  useReposStore.setState({
    added: [],
    local: { [TASK_REPO]: { hostId: 'local', path: '/src/app', displayName: 'app', tasks: [{ number: 1, title: '첫 작업', state: 'open' }] } },
    lastParent: {},
  })
})

/** Workspace 처럼 setup store 의 대상을 읽는다 — 제목을 바꾸면 머리줄도 바뀌는지 본다 */
function Header({ id }: { id: string }) {
  const target = useSetupStore((s) => s.targets[id])
  return <IssueHeader target={target} state={undefined} />
}

function renderHeader(id: string, overrides: Partial<GitHubClient> = {}) {
  const github = createFakeGitHub({
    listIssues: async () => [ISSUE_42],
    getIssue: async () => ({ ...ISSUE_42, body: '본문\n둘째 줄' }),
    updateIssue: async (_o, _r, number, input) => ({ ...ISSUE_42, number, title: input.title ?? ISSUE_42.title }),
    closeIssue: async (_o, _r, number) => ({ ...ISSUE_42, number, state: 'closed' }),
    ...overrides,
  })
  const r = renderWithDeps(
    <TooltipProvider>
      <WorktreeProvider>
        <Header id={id} />
      </WorktreeProvider>
    </TooltipProvider>,
    makeDeps({ github }),
  )
  return { github, ...r }
}

const header = () => screen.getByTestId('issue-header')

describe('GitHub 이슈 수정', () => {
  it('본문을 새로 불러오고, 제목만 바꾸면 제목만 보낸다 → 머리줄·목록 캐시·열기 대상 제목이 바뀐다', async () => {
    const user = userEvent.setup()
    const { github, queryClient } = renderHeader(GH_ID)
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.githubIssues('my-org', 'widgets'))).toBeDefined())
    await user.click(screen.getByRole('button', { name: '이슈 수정' }))
    const dialog = await screen.findByRole('dialog')
    const title = await within(dialog).findByLabelText('제목')
    expect(title).toHaveValue('Add login')
    expect(within(dialog).getByLabelText('본문')).toHaveValue('본문\n둘째 줄')
    await user.clear(title)
    await user.type(title, '  로그인 화면  ')
    await user.click(within(dialog).getByRole('button', { name: '저장' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(github.getIssue).toHaveBeenCalledWith('my-org', 'widgets', 42)
    expect(github.updateIssue).toHaveBeenCalledWith('my-org', 'widgets', 42, { title: '로그인 화면' })
    expect(header()).toHaveTextContent('#42 로그인 화면')
    expect(queryClient.getQueryData<GitHubIssue[]>(queryKeys.githubIssues('my-org', 'widgets'))?.[0].title).toBe('로그인 화면')
    expect(useSetupStore.getState().targets[GH_ID].title).toBe('로그인 화면')
    // 다시 조회하지 않는다
    expect(github.listIssues).toHaveBeenCalledTimes(1)
  })

  it('본문만 바꾸면 본문만 보내고, 아무것도 안 바꾸면 보내지 않는다', async () => {
    const user = userEvent.setup()
    const { github } = renderHeader(GH_ID)
    await user.click(screen.getByRole('button', { name: '이슈 수정' }))
    let dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('button', { name: '저장' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(github.updateIssue).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '이슈 수정' }))
    dialog = await screen.findByRole('dialog')
    await user.type(await within(dialog).findByLabelText('본문'), '{Enter}셋째 줄')
    await user.click(within(dialog).getByRole('button', { name: '저장' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(github.updateIssue).toHaveBeenCalledWith('my-org', 'widgets', 42, { body: '본문\n둘째 줄\n셋째 줄' })
  })

  it('빈 제목이면 [저장] 을 누를 수 없다', async () => {
    const user = userEvent.setup()
    renderHeader(GH_ID)
    await user.click(screen.getByRole('button', { name: '이슈 수정' }))
    const dialog = await screen.findByRole('dialog')
    await user.clear(await within(dialog).findByLabelText('제목'))
    await user.type(within(dialog).getByLabelText('제목'), '   ')
    expect(within(dialog).getByRole('button', { name: '저장' })).toBeDisabled()
  })

  it('저장에 실패하면 오류를 보이고 입력을 남긴다 — 다시 누르면 저장된다', async () => {
    const user = userEvent.setup()
    let calls = 0
    const { github } = renderHeader(GH_ID, {
      updateIssue: async (_o, _r, number, input) => {
        if (++calls === 1) throw new GitHubError('forbidden', { status: 403, message: 'Must have push access' })
        return { ...ISSUE_42, number, title: input.title ?? '' }
      },
    })
    await user.click(screen.getByRole('button', { name: '이슈 수정' }))
    const dialog = await screen.findByRole('dialog')
    const title = await within(dialog).findByLabelText('제목')
    await user.clear(title)
    await user.type(title, '새 제목')
    await user.click(within(dialog).getByRole('button', { name: '저장' }))
    expect(await within(dialog).findByText(/GitHub 접근 거부 — Must have push access/)).toBeInTheDocument()
    expect(title).toHaveValue('새 제목')
    await user.click(within(dialog).getByRole('button', { name: '저장' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(github.updateIssue).toHaveBeenCalledTimes(2)
  })

  it('불러오기에 실패하면 오류와 [다시 시도] 를 보인다', async () => {
    const user = userEvent.setup()
    let calls = 0
    renderHeader(GH_ID, {
      getIssue: async () => {
        if (++calls === 1) throw new GitHubError('network', { message: 'offline' })
        return { ...ISSUE_42, body: '' }
      },
    })
    await user.click(screen.getByRole('button', { name: '이슈 수정' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('GitHub 에 연결할 수 없습니다')
    await user.click(within(dialog).getByRole('button', { name: '다시 시도' }))
    expect(await within(dialog).findByLabelText('제목')).toHaveValue('Add login')
  })
})

describe('GitHub 이슈 닫기', () => {
  it('이유를 고르지 않으면 "완료" 로 닫는다 → [닫힘] 배지, [이슈 닫기] 가 사라지고 포커스는 [이슈 수정] 으로', async () => {
    const user = userEvent.setup()
    const { github, queryClient } = renderHeader(GH_ID)
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.githubIssues('my-org', 'widgets'))).toBeDefined())
    await user.click(screen.getByRole('button', { name: '이슈 닫기' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('radio', { name: '완료' })).toBeChecked()
    expect(within(dialog).getByText(/worktree 는 그대로 남습니다/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '이슈 닫기' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(github.closeIssue).toHaveBeenCalledWith('my-org', 'widgets', 42, 'completed')
    expect(within(header()).getByTestId('issue-closed-badge')).toHaveTextContent('닫힘')
    expect(within(header()).queryByRole('button', { name: '이슈 닫기' })).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: '이슈 수정' })).toHaveFocus())
    expect(queryClient.getQueryData<GitHubIssue[]>(queryKeys.githubIssues('my-org', 'widgets'))?.[0].state).toBe('closed')
  })

  it('"계획 없음" 을 고르면 not_planned 로 닫는다', async () => {
    const user = userEvent.setup()
    const { github } = renderHeader(GH_ID)
    await user.click(screen.getByRole('button', { name: '이슈 닫기' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: '계획 없음' }))
    await user.click(within(dialog).getByRole('button', { name: '이슈 닫기' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(github.closeIssue).toHaveBeenCalledWith('my-org', 'widgets', 42, 'not_planned')
  })

  it('실패하면 오류를 보이고 대화상자를 남긴다', async () => {
    const user = userEvent.setup()
    renderHeader(GH_ID, {
      closeIssue: async () => {
        throw new GitHubError('not_found', { status: 404, message: 'Not Found' })
      },
    })
    await user.click(screen.getByRole('button', { name: '이슈 닫기' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '이슈 닫기' }))
    expect(await within(dialog).findByText(/GitHub 오류\(not_found\)/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('이미 닫힌 이슈는 [닫힘] 배지와 [이슈 수정] 만 보인다', async () => {
    renderHeader(GH_ID, { listIssues: async () => [{ ...ISSUE_42, state: 'closed' }] })
    expect(await within(header()).findByTestId('issue-closed-badge')).toBeInTheDocument()
    expect(within(header()).getByRole('button', { name: '이슈 수정' })).toBeInTheDocument()
    expect(within(header()).queryByRole('button', { name: '이슈 닫기' })).toBeNull()
  })

  it('★기타에는 수정·닫기가 없다', () => {
    const etcId = worktreeId('my-org', 'widgets', 'etc')
    useSetupStore.setState({ targets: { [etcId]: { owner: 'my-org', repo: 'widgets', key: 'etc', number: null, title: '' } } })
    renderHeader(etcId)
    expect(within(header()).queryByRole('button', { name: /수정|닫기/ })).toBeNull()
  })
})

describe('로컬 작업', () => {
  it('제목만 고친다(본문 칸 없음, GitHub 호출 없음) → 앱의 작업·열기 대상 제목이 바뀐다', async () => {
    const user = userEvent.setup()
    const { github } = renderHeader(TASK_ID)
    await user.click(screen.getByRole('button', { name: '작업 수정' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByLabelText('본문')).toBeNull()
    const title = within(dialog).getByLabelText('제목')
    expect(title).toHaveValue('첫 작업')
    await user.clear(title)
    await user.type(title, '고친 작업')
    await user.click(within(dialog).getByRole('button', { name: '저장' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(useReposStore.getState().local[TASK_REPO].tasks[0].title).toBe('고친 작업')
    expect(useSetupStore.getState().targets[TASK_ID].title).toBe('고친 작업')
    expect(header()).toHaveTextContent('#1 고친 작업')
    expect(github.getIssue).not.toHaveBeenCalled()
    expect(github.updateIssue).not.toHaveBeenCalled()
    expect(github.listIssues).not.toHaveBeenCalled()
  })

  it('[작업 닫기] 는 확인 없이 닫고, 포커스를 [작업 수정] 으로 옮긴다', async () => {
    const user = userEvent.setup()
    const { github } = renderHeader(TASK_ID)
    await user.click(screen.getByRole('button', { name: '작업 닫기' }))
    expect(useReposStore.getState().local[TASK_REPO].tasks[0].state).toBe('closed')
    expect(within(header()).getByTestId('issue-closed-badge')).toBeInTheDocument()
    expect(within(header()).queryByRole('button', { name: '작업 닫기' })).toBeNull()
    expect(screen.getByRole('button', { name: '작업 수정' })).toHaveFocus()
    expect(github.closeIssue).not.toHaveBeenCalled()
  })

  it('GitHub 에 올리는 중이면 [작업 수정]·[작업 닫기] 를 막고 이유를 보인다(올리기가 작업이 그대로인지 확인하므로)', () => {
    useReposStore.getState().setPublish(TASK_REPO, { owner: 'me', name: 'app', private: true })
    renderHeader(TASK_ID)
    for (const name of ['작업 수정', '작업 닫기']) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeDisabled()
      expect(button).toHaveAccessibleDescription('GitHub 에 올리는 중에는 바꿀 수 없음')
    }
  })

  it('작업이 사라졌으면 저장을 실패로 알리고 머리줄 제목은 그대로 둔다', async () => {
    const user = userEvent.setup()
    renderHeader(TASK_ID)
    await user.click(screen.getByRole('button', { name: '작업 수정' }))
    const dialog = await screen.findByRole('dialog')
    useReposStore.setState({ local: {} })
    await user.clear(within(dialog).getByLabelText('제목'))
    await user.type(within(dialog).getByLabelText('제목'), '고친 작업')
    await user.click(within(dialog).getByRole('button', { name: '저장' }))
    expect(await within(dialog).findByText(/작업을 찾을 수 없습니다/)).toBeInTheDocument()
    expect(useSetupStore.getState().targets[TASK_ID].title).toBe('첫 작업')
  })
})

describe('리뷰 반영 — 기준값 고정·다시 조회·공백·캐시 없음', () => {
  it('열어 둔 사이 다시 조회해 GitHub 본문이 바뀌어도, 제목만 고치면 제목만 보낸다(옛 본문으로 덮어쓰지 않음)', async () => {
    const user = userEvent.setup()
    let calls = 0
    const { github, queryClient } = renderHeader(GH_ID, {
      getIssue: async () => ({ ...ISSUE_42, body: ++calls === 1 ? '처음 본문' : '다른 곳에서 고친 본문' }),
    })
    await user.click(screen.getByRole('button', { name: '이슈 수정' }))
    const dialog = await screen.findByRole('dialog')
    const title = await within(dialog).findByLabelText('제목')
    await queryClient.invalidateQueries({ queryKey: queryKeys.githubAll })
    await waitFor(() => expect(github.getIssue).toHaveBeenCalledTimes(2))
    expect(within(dialog).getByLabelText('본문')).toHaveValue('처음 본문')
    await user.clear(title)
    await user.type(title, '새 제목')
    await user.click(within(dialog).getByRole('button', { name: '저장' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(github.updateIssue).toHaveBeenCalledWith('my-org', 'widgets', 42, { title: '새 제목' })
  })

  it('다시 조회가 실패해도 쓰던 폼을 그대로 둔다', async () => {
    const user = userEvent.setup()
    let calls = 0
    const { github, queryClient } = renderHeader(GH_ID, {
      getIssue: async () => {
        if (++calls > 1) throw new GitHubError('rate_limited', { retryAt: null })
        return { ...ISSUE_42, body: '본문' }
      },
    })
    await user.click(screen.getByRole('button', { name: '이슈 수정' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(await within(dialog).findByLabelText('본문'), ' 추가')
    await queryClient.invalidateQueries({ queryKey: queryKeys.githubAll })
    await waitFor(() => expect(github.getIssue).toHaveBeenCalledTimes(2))
    expect(within(dialog).getByLabelText('본문')).toHaveValue('본문 추가')
    expect(within(dialog).queryByRole('button', { name: '다시 시도' })).toBeNull()
  })

  it('앞뒤 공백만 있는 기존 제목은 바뀐 것으로 보지 않는다', async () => {
    const user = userEvent.setup()
    const { github } = renderHeader(GH_ID, { getIssue: async () => ({ ...ISSUE_42, title: 'Add login ', body: '' }) })
    await user.click(screen.getByRole('button', { name: '이슈 수정' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(await within(dialog).findByLabelText('본문'), '설명')
    await user.click(within(dialog).getByRole('button', { name: '저장' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(github.updateIssue).toHaveBeenCalledWith('my-org', 'widgets', 42, { body: '설명' })
  })

  it('목록 조회에 실패해 캐시가 없어도, 닫으면 [닫힘] 배지가 보이고 [이슈 닫기] 가 사라진다', async () => {
    const user = userEvent.setup()
    const { github } = renderHeader(GH_ID, {
      listIssues: async () => {
        throw new GitHubError('rate_limited', { retryAt: null })
      },
    })
    await waitFor(() => expect(github.listIssues).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: '이슈 닫기' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '이슈 닫기' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(header()).getByTestId('issue-closed-badge')).toBeInTheDocument()
    expect(within(header()).queryByRole('button', { name: '이슈 닫기' })).toBeNull()
  })
})

describe('담당자(#86) — 머리줄', () => {
  const ME = { login: 'octocat', kind: 'user' as const, avatarUrl: null }

  it('담당자를 모두 보이고, [나에게 assign] ↔ [내 assign 해제] 로 바꾼다', async () => {
    const user = userEvent.setup()
    const { github } = renderHeader(GH_ID, {
      listOwners: async () => [ME],
      listIssues: async () => [{ ...ISSUE_42, assignees: ['alice'] }],
      assignIssue: async (_o, _r, _n, login) => ({ ...ISSUE_42, assignees: ['alice', login] }),
      unassignIssue: async () => ({ ...ISSUE_42, assignees: ['alice'] }),
    })
    expect(await within(header()).findByText('@alice')).toBeInTheDocument()

    await user.click(await within(header()).findByRole('button', { name: '나에게 assign' }))
    expect(github.assignIssue).toHaveBeenCalledWith('my-org', 'widgets', 42, 'octocat')
    expect(await within(header()).findByText('@octocat, @alice')).toBeInTheDocument()

    await user.click(within(header()).getByRole('button', { name: '내 assign 해제' }))
    expect(github.unassignIssue).toHaveBeenCalledWith('my-org', 'widgets', 42, 'octocat')
    expect(await within(header()).findByText('@alice')).toBeInTheDocument()
    expect(github.listIssues).toHaveBeenCalledTimes(1)
  })

  it('실패하면 머리줄에 오류를 보인다 · 로컬 작업에는 assign 이 없다', async () => {
    const user = userEvent.setup()
    const { unmount } = renderHeader(GH_ID, {
      listOwners: async () => [ME],
      assignIssue: async () => {
        throw new GitHubError('forbidden', { message: 'Must have push access' })
      },
    })
    await user.click(await within(header()).findByRole('button', { name: '나에게 assign' }))
    expect(await within(header()).findByRole('alert')).toHaveTextContent('GitHub 접근 거부 — Must have push access')
    unmount()

    renderHeader(TASK_ID, { listOwners: async () => [ME] })
    expect(within(header()).getByRole('button', { name: '작업 수정' })).toBeInTheDocument()
    expect(within(header()).queryByRole('button', { name: /assign/ })).toBeNull()
  })
})

describe('#116 이슈 탭과 [이슈 수정]', () => {
  /** 머리줄 + 이슈 탭을 함께 렌더한다(이슈 탭과 대화상자가 같은 getIssue 를 쓴다) */
  function renderHeaderWithTab(overrides: Partial<GitHubClient>) {
    const github = createFakeGitHub({
      listIssues: async () => [ISSUE_42],
      updateIssue: async (_o, _r, number, input) => ({ ...ISSUE_42, number, title: input.title ?? ISSUE_42.title }),
      ...overrides,
    })
    const r = renderWithDeps(
      <TooltipProvider>
        <WorktreeProvider>
          <Header id={GH_ID} />
          <div data-testid="issue-tab">
            <IssueTab target={GH} />
          </div>
        </WorktreeProvider>
      </TooltipProvider>,
      makeDeps({ github }),
    )
    return { github, ...r }
  }

  const tab = () => screen.getByTestId('issue-tab')

  async function saveBody(body: string) {
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '이슈 수정' }))
    const dialog = await screen.findByRole('dialog')
    const field = await within(dialog).findByLabelText('본문')
    await user.clear(field)
    await user.type(field, body)
    await user.click(within(dialog).getByRole('button', { name: '저장' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  }

  it('AC-04 탭에서 옛 본문을 보는 중에 본문을 저장하면 다시 조회하지 않고 같은 탭이 새 본문을 보인다', async () => {
    // GitHub 은 계속 옛 본문을 돌려준다 — 다시 조회로는 새 본문을 볼 수 없다
    const { github } = renderHeaderWithTab({ getIssue: async () => ({ ...ISSUE_42, body: '옛 본문' }) })
    expect(await within(tab()).findByText('옛 본문')).toBeInTheDocument()
    await saveBody('새 본문')
    expect(github.updateIssue).toHaveBeenCalledWith('my-org', 'widgets', 42, { body: '새 본문' })
    expect(await within(tab()).findByText('새 본문')).toBeInTheDocument()
    expect(within(tab()).queryByText('옛 본문')).toBeNull()
  })

  it('AC-04 탭이 첫 조회 중일 때 본문을 저장하면 저장 뒤 다시 받아 새 본문을 보인다("불러오는 중…"에 멈추지 않음)', async () => {
    let calls = 0
    let current = '옛 본문'
    renderHeaderWithTab({
      // 1번째(탭의 첫 조회)는 끝나지 않는다. 그 뒤(대화상자·다시 조회)는 GitHub 의 지금 본문
      getIssue: () => (++calls === 1 ? new Promise<never>(() => {}) : Promise.resolve({ ...ISSUE_42, body: current })),
      updateIssue: async (_o, _r, number, input) => {
        if (input.body !== undefined) current = input.body
        return { ...ISSUE_42, number, title: input.title ?? ISSUE_42.title }
      },
    })
    expect(await within(tab()).findByText('불러오는 중…')).toBeInTheDocument()
    await saveBody('새 본문')
    expect(await within(tab()).findByText('새 본문')).toBeInTheDocument()
    expect(within(tab()).queryByText('불러오는 중…')).toBeNull()
  })

  it('EC-09 탭에서 본문을 본 뒤 다른 곳에서 본문이 바뀌면, [이슈 수정] 의 본문 칸은 새 본문이다(탭 캐시를 쓰지 않음)', async () => {
    const user = userEvent.setup()
    let current = '옛 본문'
    renderHeaderWithTab({ getIssue: async () => ({ ...ISSUE_42, body: current }) })
    expect(await within(tab()).findByText('옛 본문')).toBeInTheDocument()
    current = '다른 곳에서 바꾼 본문'
    await user.click(screen.getByRole('button', { name: '이슈 수정' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByLabelText('본문')).toHaveValue('다른 곳에서 바꾼 본문')
  })
})
