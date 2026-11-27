// 설정 화면 작업 공간 분류(#115) — 범위 선택(radiogroup "범위")과 그 범위의 설정.
// 범위 문맥(target)·범위(scope)는 설정 화면 store 한 곳에 있다 — 테스트는 store 를 직접 정해 둔다
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import type { SettingsRecord, SettingsScope } from '@minmo/api-client'
import { worktreeId } from '@minmo/core'

import { useHostsStore } from '../../store/hosts'
import { LOCAL_OWNER, repoKey, useReposStore } from '../../store/repos'
import { useSessionStore } from '../../store/session'
import { useSettingsPageStore } from '../../store/settingsPage'
import type { SettingsTarget } from '../../store/settingsPage'
import { useUiStore } from '../../store/ui'
import { createFakeApi, deferred, flush } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import type { PreviewIssue } from './ScopeSettings'
import { WorkspaceSection } from './WorkspaceSection'

const GLOBAL: SettingsRecord = {
  branchTemplate: 'issue/{number}-{slug}',
  etcBranchName: 'etc',
  worktreePath: '~/minmo-workspaces/{owner}/{repo}/{branch}',
  mainClonePath: '~/minmo-workspaces/{owner}/{repo}/_main',
  postCreateScript: '',
  sparsePaths: '',
  postCreateScriptPosix: '',
  ignoredCopyExclude: 'node_modules',
  updatedAt: '2026-11-09T00:00:00.000Z',
}
const EMPTY: SettingsRecord = {
  branchTemplate: null,
  etcBranchName: null,
  worktreePath: null,
  mainClonePath: null,
  postCreateScript: null,
  sparsePaths: null,
  postCreateScriptPosix: null,
  ignoredCopyExclude: null,
  updatedAt: null,
}

type Context = SettingsTarget['context']
const PROJECT: Context = { kind: 'project', owner: 'my-org', repo: 'widgets' }
const ORG: Context = { kind: 'org', owner: 'my-org' }
const ISSUE: PreviewIssue = { owner: 'my-org', repo: 'widgets', key: '7', number: 7, title: 'Fix bug' }
const PROJECT_TARGET: SettingsTarget = { context: PROJECT, preview: ISSUE }

function setup(o: { target: SettingsTarget | null; scope: SettingsScope }) {
  useSettingsPageStore.setState({ target: o.target, scope: o.scope })
  const api = createFakeApi({
    getSettings: async (s) => (s.kind === 'global' ? GLOBAL : EMPTY),
    putSettings: async (_s, i) => ({ ...EMPTY, ...i, updatedAt: '2026-11-09T00:00:05.000Z' }) as SettingsRecord,
  })
  const user = userEvent.setup()
  const view = renderWithDeps(<WorkspaceSection />, makeDeps({ api, home: '/home/u', platform: 'linux' }))
  return { api, user, ...view }
}

// 아래 폼에도 radiogroup 이 있다(생성 후 스크립트 등) — 범위 라디오는 이름 "범위" 그룹 안에서만 찾는다
const scopeGroup = () => screen.findByRole('radiogroup', { name: '범위' })
const scopeRadio = async (name: string) => within(await scopeGroup()).getByRole('radio', { name })

async function expectScopeRadios(names: string[]) {
  const radios = within(await scopeGroup()).getAllByRole('radio')
  expect(radios).toHaveLength(names.length)
  names.forEach((name, i) => expect(radios[i]).toHaveAccessibleName(name))
}

const scopeHeading = (name: string) => screen.findByRole('heading', { level: 3, name })

beforeEach(() => {
  useSettingsPageStore.setState(useSettingsPageStore.getInitialState(), true)
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
  useHostsStore.setState({ aliases: [], selected: null, baseRepos: {}, baseDirs: {}, repoHosts: {} })
  // 별칭을 정해 둔다 — 프로젝트 라벨이 "owner/repo" 인지 짧은 이름인지 헷갈리지 않게
  useReposStore.setState({ local: {}, nicknames: { [repoKey('my-org', 'widgets')]: 'wdg' } })
  useUiStore.setState({ selectedIssueId: null })
})

describe('작업 공간 — 범위 선택', () => {
  it('AC-09 범위 후보는 store 의 범위 문맥에서 나온다 — 프로젝트 문맥은 전역·조직·프로젝트, 조직 문맥은 전역·조직이고 store scope 가 선택돼 있다', async () => {
    const first = setup({ target: PROJECT_TARGET, scope: PROJECT })
    await expectScopeRadios(['전역', '조직: my-org', '프로젝트: wdg'])
    expect(await scopeRadio('프로젝트: wdg')).toBeChecked()
    expect(await scopeHeading('프로젝트 설정 — wdg')).toBeInTheDocument()
    first.unmount()

    setup({ target: { context: ORG, preview: ISSUE }, scope: ORG })
    await expectScopeRadios(['전역', '조직: my-org'])
    expect(await scopeRadio('조직: my-org')).toBeChecked()
    expect(await scopeHeading('조직 설정 — my-org')).toBeInTheDocument()
  })

  it('AC-09 범위를 고르면 store scope 가 바뀌고 그 범위의 설정을 보인다', async () => {
    const { user } = setup({ target: PROJECT_TARGET, scope: PROJECT })
    expect(await scopeHeading('프로젝트 설정 — wdg')).toBeInTheDocument()
    expect(await screen.findByLabelText('별칭')).toBeInTheDocument()

    await user.click(await scopeRadio('조직: my-org'))
    expect(useSettingsPageStore.getState().scope).toEqual(ORG)
    expect(await scopeRadio('조직: my-org')).toBeChecked()
    expect(await scopeHeading('조직 설정 — my-org')).toBeInTheDocument()
    expect(screen.queryByLabelText('별칭')).toBeNull()

    await user.click(await scopeRadio('전역'))
    expect(useSettingsPageStore.getState().scope).toEqual({ kind: 'global' })
    expect(await scopeHeading('전역 설정')).toBeInTheDocument()
    // 전역은 상속 선택지가 없다
    await waitFor(() => expect(screen.getByLabelText('브랜치 템플릿')).toHaveValue('issue/{number}-{slug}'))
    expect(screen.queryByRole('radio', { name: '상속' })).toBeNull()
  })

  it('EC-05 범위를 바꾸면 저장하지 않은 입력은 버린다', async () => {
    const { user } = setup({ target: PROJECT_TARGET, scope: PROJECT })
    // 프로젝트 레코드를 먼저 불러 둔다 — 다시 돌아올 때 바로 그려지는 경우에도 입력이 남지 않아야 한다
    await waitFor(() => expect(screen.getByLabelText('브랜치 템플릿')).toHaveAttribute('placeholder', '상속: issue/{number}-{slug}'))

    await user.click(await scopeRadio('조직: my-org'))
    await scopeHeading('조직 설정 — my-org')
    const branch = await screen.findByLabelText('브랜치 템플릿')
    await user.click(branch)
    await user.paste('feat/{number}')
    expect(branch).toHaveValue('feat/{number}')

    await user.click(await scopeRadio('프로젝트: wdg'))
    await scopeHeading('프로젝트 설정 — wdg')
    await waitFor(() => expect(screen.getByLabelText('브랜치 템플릿')).toHaveAttribute('placeholder', '상속: issue/{number}-{slug}'))
    expect(screen.getByLabelText('브랜치 템플릿')).toHaveValue('')
  })

  it('EC-15 로컬 저장소는 조직 범위 라벨이 로컬 저장소 공통, 프로젝트 범위 라벨이 별칭이고 연결 호스트·원본 위치가 없다', async () => {
    const local: Context = { kind: 'project', owner: LOCAL_OWNER, repo: 'app-0001' }
    useReposStore.setState({
      local: { 'app-0001': { hostId: 'local', path: '/src/app', displayName: 'app', tasks: [] } },
      nicknames: { [repoKey(LOCAL_OWNER, 'app-0001')]: 'my app' },
    })
    setup({ target: { context: local, preview: null }, scope: local })
    await expectScopeRadios(['전역', '로컬 저장소 공통', '프로젝트: my app'])
    expect(await scopeRadio('프로젝트: my app')).toBeChecked()
    expect(await scopeHeading('프로젝트 설정 — my app')).toBeInTheDocument()
    await screen.findByLabelText('브랜치 템플릿')
    expect(screen.queryByLabelText('연결 호스트')).toBeNull()
    expect(screen.queryByTestId('base-repo-section')).toBeNull()
  })

  it('EC-18 저장했습니다 는 다음 저장을 시작하면 지우고, 저장 중에 범위를 바꾸면 이전 범위의 늦은 완료는 새 범위에 아무것도 보이지 않는다', async () => {
    const { api, user } = setup({ target: PROJECT_TARGET, scope: ORG })
    await screen.findByLabelText('브랜치 템플릿')
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByText('저장했습니다')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toBeEnabled())

    // 다음 저장을 시작하면 지운다
    const late = deferred<SettingsRecord>()
    api.putSettings.mockImplementation(() => late.promise)
    await user.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(api.putSettings).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('저장했습니다')).toBeNull()

    // 저장이 끝나기 전에 범위를 바꾼다
    await user.click(await scopeRadio('전역'))
    await scopeHeading('전역 설정')
    await waitFor(() => expect(screen.getByLabelText('브랜치 템플릿')).toHaveValue('issue/{number}-{slug}'))
    await act(async () => {
      late.resolve({ ...EMPTY, branchTemplate: 'late/{number}', updatedAt: '2026-11-09T00:00:06.000Z' })
      await flush()
    })
    expect(screen.queryByText('저장했습니다')).toBeNull()
    expect(screen.getByLabelText('브랜치 템플릿')).toHaveValue('issue/{number}-{slug}')
  })

  it('EC-21 열린 채 고른 이슈가 바뀌어도 범위 후보·preview 는 연 때의 값이다', async () => {
    useUiStore.setState({ selectedIssueId: worktreeId('my-org', 'widgets', '7') })
    setup({ target: PROJECT_TARGET, scope: PROJECT })
    await waitFor(() => expect(screen.getByTestId('preview-branch')).toHaveTextContent('issue/7-fix-bug'))

    act(() => useUiStore.setState({ selectedIssueId: worktreeId('other-org', 'gadgets', '3') }))
    await expectScopeRadios(['전역', '조직: my-org', '프로젝트: wdg'])
    expect(await scopeRadio('프로젝트: wdg')).toBeChecked()
    expect(screen.getByTestId('preview-branch')).toHaveTextContent('issue/7-fix-bug')
  })

  it('EC-27 범위 후보가 전역 하나면 radiogroup 대신 범위: 전역 텍스트를 보인다', async () => {
    setup({ target: null, scope: { kind: 'global' } })
    expect(await screen.findByText('범위: 전역')).toBeInTheDocument()
    expect(await scopeHeading('전역 설정')).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: '범위' })).toBeNull()
  })

  it('EC-29 다른 분류에 갔다 돌아와도(다시 마운트) 범위는 처음 값으로 돌아가지 않고 store 값 그대로다', async () => {
    const { api, user, unmount } = setup({ target: PROJECT_TARGET, scope: PROJECT })
    await user.click(await scopeRadio('조직: my-org'))
    expect(useSettingsPageStore.getState().scope).toEqual(ORG)
    unmount()

    renderWithDeps(<WorkspaceSection />, makeDeps({ api, home: '/home/u', platform: 'linux' }))
    expect(await scopeRadio('조직: my-org')).toBeChecked()
    expect(await scopeHeading('조직 설정 — my-org')).toBeInTheDocument()
  })
})
