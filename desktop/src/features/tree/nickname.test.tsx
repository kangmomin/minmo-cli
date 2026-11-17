// 저장소 별칭(#73) — 트리·표시할 저장소 대화상자에서 원래 이름 대신 별칭을 보이고, 별칭으로도 찾는다
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { TooltipProvider } from '../../components/ui/tooltip'
import { useReposStore } from '../../store/repos'
import { useSessionStore } from '../../store/session'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { Sidebar } from './Sidebar'

const ACME = { login: 'Acme', kind: 'org' as const, avatarUrl: null }
const REPOS = [
  { owner: 'Acme', name: 'very-long-widgets-service', defaultBranch: 'main' },
  { owner: 'Acme', name: 'gadgets', defaultBranch: 'main' },
]

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
  useUiStore.setState({ expanded: { 'org:Acme': true }, worktreePathMap: {} })
  useReposStore.setState({ added: [], local: {}, nicknames: { 'acme/very-long-widgets-service': 'wg' } })
})

function setup() {
  const api = createFakeApi({ getVisibleRepos: async () => ({ repos: null, updatedAt: null }) })
  const github = createFakeGitHub({ listOwners: async () => [ACME], listRepos: async () => REPOS })
  renderWithDeps(
    <TooltipProvider>
      <Sidebar onOpenSettings={() => {}} />
    </TooltipProvider>,
    makeDeps({ api, github }),
  )
  return { user: userEvent.setup() }
}

describe('트리', () => {
  it('별칭이 있으면 별칭만 보이고, 마우스를 올리면 owner/name · 버튼 이름도 별칭', async () => {
    setup()
    const node = await screen.findByTestId('repo-node-Acme/very-long-widgets-service')
    expect(node).toHaveTextContent('wg')
    expect(node).not.toHaveTextContent('very-long-widgets-service')
    expect(within(node).getByTitle('Acme/very-long-widgets-service')).toHaveTextContent('wg')
    expect(screen.getByRole('button', { name: 'wg 프로젝트 설정' })).toBeInTheDocument()
    // 별칭이 없는 저장소는 그대로
    expect(screen.getByTestId('repo-node-Acme/gadgets')).toHaveTextContent('gadgets')
  })

  it('별칭을 바꾸면 트리가 바로 바뀐다', async () => {
    setup()
    const node = await screen.findByTestId('repo-node-Acme/gadgets')
    useReposStore.getState().setNickname('Acme', 'gadgets', 'gd')
    expect(await within(node).findByText('gd')).toBeInTheDocument()
  })
})

describe('표시할 저장소 대화상자', () => {
  it('별칭으로도 찾고, 목록에는 별칭을 보인다', async () => {
    const { user } = setup()
    await user.click(await screen.findByRole('button', { name: '표시할 저장소' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: '고른 저장소만' }))
    await user.type(within(dialog).getByLabelText('저장소 검색'), 'wg')
    expect(await within(dialog).findByRole('checkbox', { name: 'wg' })).toBeInTheDocument()
    expect(within(dialog).getByText('wg')).toHaveAttribute('title', 'Acme/very-long-widgets-service')
    expect(within(dialog).queryByRole('checkbox', { name: 'gadgets' })).toBeNull()
    // 원래 이름으로도 찾는다
    await user.clear(within(dialog).getByLabelText('저장소 검색'))
    await user.type(within(dialog).getByLabelText('저장소 검색'), 'widgets')
    expect(await within(dialog).findByRole('checkbox', { name: 'wg' })).toBeInTheDocument()
  })
})
