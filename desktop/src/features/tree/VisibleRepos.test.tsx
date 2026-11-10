// 보일 저장소(E15/E16) — 트리 필터·worktree 있는 저장소의 "숨김" 표시·선택 다이얼로그 저장/409
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import type { VisibleRepos } from '@minmo/api-client'
import { worktreeId } from '@minmo/core'

import { TooltipProvider } from '../../components/ui/tooltip'
import { useSessionStore } from '../../store/session'
import { useUiStore } from '../../store/ui'
import { apiError, createFakeApi, createFakeGitHub } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { Sidebar } from './Sidebar'

const ACME = { login: 'Acme', kind: 'org' as const, avatarUrl: null }
const ZED = { login: 'zed', kind: 'org' as const, avatarUrl: null }
const REPOS: Record<string, { owner: string; name: string; defaultBranch: string }[]> = {
  Acme: [
    { owner: 'Acme', name: 'Widgets', defaultBranch: 'main' },
    { owner: 'Acme', name: 'gadgets', defaultBranch: 'main' },
  ],
  zed: [{ owner: 'zed', name: 'tools', defaultBranch: 'main' }],
}

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
  useUiStore.setState({ expanded: { 'org:Acme': true, 'org:zed': true }, worktreePathMap: {} })
})

function setup(selection: VisibleRepos, put?: (repos: string[] | null) => Promise<VisibleRepos>) {
  const api = createFakeApi({
    getVisibleRepos: async () => selection,
    putVisibleRepos: async (input) => (put ? put(input.repos) : { repos: input.repos, updatedAt: '2026-11-10T00:00:01.000Z' }),
  })
  const github = createFakeGitHub({ listOwners: async () => [ACME, ZED], listRepos: async (o) => REPOS[o.login] ?? [] })
  renderWithDeps(
    <TooltipProvider>
      <Sidebar onOpenSettings={() => {}} />
    </TooltipProvider>,
    makeDeps({ api, github }),
  )
  return { api, user: userEvent.setup() }
}

describe('트리 필터', () => {
  it('선택 없음(null) 이면 전부 보인다', async () => {
    setup({ repos: null, updatedAt: null })
    expect(await screen.findByTestId('repo-node-Acme/Widgets')).toBeInTheDocument()
    expect(await screen.findByTestId('repo-node-zed/tools')).toBeInTheDocument()
  })

  it('고른 저장소만 — 대소문자 무시, 고른 것이 없는 조직은 숨김', async () => {
    setup({ repos: ['acme/widgets'], updatedAt: '2026-11-10T00:00:00.000Z' })
    expect(await screen.findByTestId('repo-node-Acme/Widgets')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('repo-node-Acme/gadgets')).toBeNull())
    expect(screen.queryByTestId('org-node-zed')).toBeNull()
    expect(screen.getByRole('button', { name: '표시할 저장소' })).toBeInTheDocument()
  })

  it('숨긴 저장소라도 로컬 worktree 가 있으면 "숨김" 표시와 함께 보인다', async () => {
    useUiStore.setState({ worktreePathMap: { [worktreeId('zed', 'tools', '7')]: { path: '/w/7', branch: 'b' } } })
    setup({ repos: ['acme/*'], updatedAt: '2026-11-10T00:00:00.000Z' })
    const node = await screen.findByTestId('repo-node-zed/tools')
    expect(within(node).getByText('숨김')).toBeInTheDocument()
    expect(await screen.findByTestId('repo-node-Acme/gadgets')).toBeInTheDocument()
  })
})

describe('표시할 저장소 다이얼로그', () => {
  it('고른 저장소만 → 체크해 저장하면 baseUpdatedAt 과 함께 PUT', async () => {
    const { api, user } = setup({ repos: null, updatedAt: null })
    await user.click(await screen.findByRole('button', { name: '표시할 저장소' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('radio', { name: '고른 저장소만' }))
    await user.click(within(dialog).getByRole('button', { name: 'Acme 저장소 펼치기' }))
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Widgets' }))
    await user.click(within(dialog).getByRole('checkbox', { name: 'zed 전체' }))
    await user.click(within(dialog).getByRole('button', { name: '저장' }))
    await waitFor(() => expect(api.putVisibleRepos).toHaveBeenCalledTimes(1))
    expect(api.putVisibleRepos.mock.calls[0][0]).toEqual({ repos: ['acme/widgets', 'zed/*'], baseUpdatedAt: null })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('검색하면 모든 조직에서 이름으로 거른다 · "모든 저장소" 로 저장하면 null', async () => {
    const { api, user } = setup({ repos: ['zed/tools'], updatedAt: '2026-11-10T00:00:00.000Z' })
    await user.click(await screen.findByRole('button', { name: '표시할 저장소' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('저장소 검색'), 'gad')
    expect(await within(dialog).findByRole('checkbox', { name: 'gadgets' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('checkbox', { name: 'Widgets' })).toBeNull()
    await user.click(within(dialog).getByRole('radio', { name: '모든 저장소' }))
    await user.click(within(dialog).getByRole('button', { name: '저장' }))
    await waitFor(() => expect(api.putVisibleRepos).toHaveBeenCalledTimes(1))
    expect(api.putVisibleRepos.mock.calls[0][0]).toEqual({ repos: null, baseUpdatedAt: '2026-11-10T00:00:00.000Z' })
  })

  it('409 conflict → 다시 불러와도(새 updatedAt) 안내가 남고 다이얼로그 유지', async () => {
    const { api, user } = setup({ repos: null, updatedAt: null }, async () => {
      throw apiError(409, 'conflict')
    })
    // 재조회는 다른 기기가 저장한 새 값을 돌려준다 — 폼이 새로 마운트돼도 안내는 남아야 한다
    api.getVisibleRepos.mockResolvedValue({ repos: ['zed/tools'], updatedAt: '2026-11-10T00:00:09.000Z' })
    await user.click(await screen.findByRole('button', { name: '표시할 저장소' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: '저장' }))
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: '고른 저장소만' })).toBeChecked())
    expect(within(dialog).getByRole('alert')).toHaveTextContent('먼저 바뀌었습니다')
  })
})
