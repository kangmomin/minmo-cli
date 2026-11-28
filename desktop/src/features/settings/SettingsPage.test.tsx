// 설정 화면(#115) — 근거: AC-02, 03, 05, 11, 16, 17, 18, EC-01, 02, 03, 05(분류·검색 전환), 10, 17, 19, 22
//
// 접근성 계약: dialog "설정", searchbox "설정 검색", tablist "설정 분류", 머리줄 버튼 "닫기", 분류 tabpanel 의 h2 = 분류 제목,
// 검색창 아래 항상 있는 status "분류 N개" / "일치하는 설정이 없습니다". 상단 ⚙ 는 data-settings-trigger(Workspace) — 여기서는 자리만 둔다
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SettingsRecord } from '@minmo/api-client'

import { TooltipProvider } from '../../components/ui/tooltip'
import type { RuntimeKind } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { useReposStore } from '../../store/repos'
import { useSessionStore } from '../../store/session'
import { openSettings, useSettingsPageStore } from '../../store/settingsPage'
import type { SettingsTarget } from '../../store/settingsPage'
import { createFakeApi, createFakeTauri } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import type { SectionId } from './sections'
import { SettingsPage } from './SettingsPage'

// 좁은 화면·터치 기기 여부를 테스트마다 정한다(jsdom 에는 matchMedia 가 없다)
const media = vi.hoisted(() => ({ narrow: false, touch: false }))
vi.mock('../terminal/TerminalKeyBar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../terminal/TerminalKeyBar')>()),
  useNarrow: () => media.narrow,
  useTouch: () => media.touch,
}))

type User = ReturnType<typeof userEvent.setup>
/** 보이는 분류를 떠나는 방법 */
type Leave = (user: User, dlg: HTMLElement) => Promise<void>

const MOCK_TABS = ['모양', '알림·표시', '에이전트', '작업 공간', '원격 호스트', '원격 접속', '원격 CLI', '서버·앱']
const NATIVE_TABS = ['모양', '알림·표시', '에이전트', '작업 공간', '동기화', '원격 호스트', '원격 접속', '원격 CLI', '서버·앱']
const PROJECT: SettingsTarget['context'] = { kind: 'project', owner: 'MyOrg', repo: 'Repo-A' }
const RECORD: SettingsRecord = {
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

function setup(o: { runtime?: RuntimeKind } = {}) {
  const fake = createFakeTauri({ runtime: o.runtime ?? 'mock' })
  const api = createFakeApi({ getSettings: async () => RECORD })
  const user = userEvent.setup()
  const view = renderWithDeps(
    <TooltipProvider>
      <p>작업 화면</p>
      <button type="button">연 버튼</button>
      <button type="button" aria-label="설정" data-settings-trigger>
        ⚙
      </button>
      <SettingsPage />
    </TooltipProvider>,
    makeDeps({ api, tauri: fake.tauri }),
  )
  return { fake, user, view }
}

async function open(o?: Parameters<typeof openSettings>[0]) {
  act(() => openSettings(o))
  return screen.findByRole('dialog', { name: '설정' })
}

const searchbox = (dlg: HTMLElement) => within(dlg).getByRole('searchbox', { name: '설정 검색' })
const tab = (dlg: HTMLElement, name: string) => within(dlg).getByRole('tab', { name })
const selectedTab = (dlg: HTMLElement) => within(dlg).getByRole('tab', { selected: true })
/** 보이는 분류의 제목(tabpanel 안의 h2) */
const panelTitle = (dlg: HTMLElement) => within(within(dlg).getByRole('tabpanel')).getByRole('heading', { level: 2 })

/** 탭 목록 — 이름과 순서가 names 와 같아야 한다 */
function expectTabs(dlg: HTMLElement, names: string[]) {
  const list = within(dlg).getByRole('tablist', { name: '설정 분류' })
  expect(within(list).getAllByRole('tab')).toEqual(names.map((name) => within(list).getByRole('tab', { name })))
}

/** 검색창 아래 status — 문구로 찾고, 그 문구가 status 안에 있어야 한다 */
function searchStatus(dlg: HTMLElement, text: string): HTMLElement {
  const el = within(dlg).getByText(text).closest<HTMLElement>('[role="status"]')
  expect(el).not.toBeNull()
  return el!
}

async function typeSearch(user: User, dlg: HTMLElement, text: string) {
  await user.click(searchbox(dlg))
  await user.paste(text)
}

beforeEach(() => {
  useSettingsPageStore.setState(useSettingsPageStore.getInitialState(), true)
  media.narrow = false
  media.touch = false
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
  useHostsStore.setState({ aliases: [], selected: null, repoHosts: {}, baseRepos: {} })
  useReposStore.setState({ local: {}, nicknames: {} })
})

describe('SettingsPage', () => {
  it('AC-02 열면 dialog 설정 에 searchbox·tablist 가 있고, 탭은 보임 조건을 만족하는 분류만 표 순서로 있다', async () => {
    setup()
    const dlg = await open()
    expect(searchbox(dlg)).toBeInTheDocument()
    expectTabs(dlg, MOCK_TABS)
  })

  it('AC-03 분류 탭을 활성화하면 그 분류의 tabpanel 만 렌더된다(h2 = 분류 제목)', async () => {
    const { user } = setup()
    const dlg = await open()
    await user.click(tab(dlg, '원격 호스트'))
    const panels = within(dlg).getAllByRole('tabpanel')
    expect(panels).toHaveLength(1)
    expect(within(panels[0]).getByRole('heading', { level: 2, name: '원격 호스트' })).toBeInTheDocument()
    expect(within(dlg).queryByRole('heading', { level: 2, name: '모양' })).toBeNull()
  })

  it('AC-05 닫고 다시 열면 마지막으로 보인 분류가 선택돼 있고 검색어는 비어 있다(첫 열기 = 모양)', async () => {
    const { user } = setup()
    let dlg = await open()
    expect(selectedTab(dlg)).toHaveAccessibleName('모양')
    await user.click(tab(dlg, '원격 호스트'))
    await typeSearch(user, dlg, 'ssh')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull())

    dlg = await open()
    expect(selectedTab(dlg)).toHaveAccessibleName('원격 호스트')
    expect(searchbox(dlg)).toHaveValue('')
    expectTabs(dlg, MOCK_TABS)
  })

  it('AC-11 이 PC 의 창(native)에는 동기화 분류가 있고 페어링 동기화 내용을 보인다', async () => {
    setup({ runtime: 'native' })
    const dlg = await open({ section: 'sync' })
    expectTabs(dlg, NATIVE_TABS)
    expect(selectedTab(dlg)).toHaveAccessibleName('동기화')
    expect(panelTitle(dlg)).toHaveTextContent('동기화')
    expect(within(within(dlg).getByRole('tabpanel')).getByText('설정 동기화 (페어링 코드)')).toBeInTheDocument()
  })

  // 제목 보간은 %s(튜플)로 한다 — $키(객체)는 문자열에 따옴표가 붙어 테스트 ID 가 흐려진다
  it.each<[string, string, boolean]>([
    ['Esc', '연 요소', true],
    ['머리줄 닫기', '상단 ⚙(연 요소 없음)', false],
  ])('AC-16 %s → 설정이 닫히고 작업 화면은 그대로, 포커스는 %s', async (how, _label, opener) => {
    const { user } = setup()
    if (opener) screen.getByRole('button', { name: '연 버튼' }).focus()
    const dlg = await open()
    if (how === 'Esc') await user.keyboard('{Escape}')
    else await user.click(within(dlg).getByRole('button', { name: '닫기' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull())
    expect(useSettingsPageStore.getState().open).toBe(false)
    expect(screen.getByText('작업 화면')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: opener ? '연 버튼' : '설정' })).toHaveFocus())
  })

  it.each<[string, boolean, SectionId | undefined, string]>([
    ['⚙ 로 열면 검색창', false, undefined, '설정 검색'],
    ['터치 기기는 선택된 탭', true, undefined, '모양'],
    ['분류를 지정해 열면 선택된 탭', false, 'hosts', '원격 호스트'],
  ])('AC-17 첫 포커스 — %s', async (_when, touch, section, focus) => {
    media.touch = touch
    setup()
    const dlg = await open(section ? { section } : undefined)
    const target = focus === '설정 검색' ? searchbox(dlg) : tab(dlg, focus)
    await waitFor(() => expect(target).toHaveFocus())
  })

  it('AC-18 넓은 화면: 세로 tablist — ↑↓·Home/End 는 포커스만 옮기고 Enter/Space 로 연다', async () => {
    const { user } = setup()
    const dlg = await open()
    expect(within(dlg).getByRole('tablist', { name: '설정 분류' })).toHaveAttribute('aria-orientation', 'vertical')
    act(() => tab(dlg, '모양').focus())
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(tab(dlg, '알림·표시')).toHaveFocus())
    expect(selectedTab(dlg)).toHaveAccessibleName('모양')
    await user.keyboard('{End}')
    await waitFor(() => expect(tab(dlg, '서버·앱')).toHaveFocus())
    await user.keyboard('{ArrowUp}')
    await waitFor(() => expect(tab(dlg, '원격 CLI')).toHaveFocus())
    await user.keyboard('{Home}')
    await waitFor(() => expect(tab(dlg, '모양')).toHaveFocus())
    expect(selectedTab(dlg)).toHaveAccessibleName('모양')

    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(tab(dlg, '알림·표시')).toHaveFocus())
    await user.keyboard('{Enter}')
    expect(selectedTab(dlg)).toHaveAccessibleName('알림·표시')
    expect(panelTitle(dlg)).toHaveTextContent('알림·표시')
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(tab(dlg, '에이전트')).toHaveFocus())
    await user.keyboard(' ')
    expect(selectedTab(dlg)).toHaveAccessibleName('에이전트')
  })

  it('AC-18 좁은 화면: 가로 tablist — ←→ 는 포커스만 옮긴다', async () => {
    media.narrow = true
    const { user } = setup()
    const dlg = await open()
    expect(within(dlg).getByRole('tablist', { name: '설정 분류' })).toHaveAttribute('aria-orientation', 'horizontal')
    act(() => tab(dlg, '모양').focus())
    await user.keyboard('{ArrowRight}')
    await waitFor(() => expect(tab(dlg, '알림·표시')).toHaveFocus())
    expect(selectedTab(dlg)).toHaveAccessibleName('모양')
    await user.keyboard('{ArrowLeft}')
    await waitFor(() => expect(tab(dlg, '모양')).toHaveFocus())
  })

  it('AC-18 검색창 아래 status 는 항상 있고 분류 수를 알린다', async () => {
    const { user } = setup()
    const dlg = await open()
    const status = searchStatus(dlg, '분류 8개')
    await typeSearch(user, dlg, '포트')
    expect(status).toHaveTextContent('분류 3개')
  })

  it('EC-01 검색 결과가 0 이면 tablist·내용이 없고 status 는 일치하는 설정이 없습니다', async () => {
    const { user } = setup()
    const dlg = await open()
    const status = searchStatus(dlg, '분류 8개')
    expect(within(dlg).getByRole('tabpanel')).toBeInTheDocument()
    await typeSearch(user, dlg, 'zzzz')
    expect(within(dlg).queryByRole('tablist')).toBeNull()
    expect(within(dlg).queryByRole('tabpanel')).toBeNull()
    expect(status).toHaveTextContent('일치하는 설정이 없습니다')
  })

  it('EC-02 보이는 분류가 결과에 있으면 그대로(검색어를 지워도 되돌아가지 않음), 걸러지면 첫 결과를 보인다', async () => {
    const { fake, user } = setup()
    const dlg = await open({ section: 'remote' })
    await within(dlg).findByRole('checkbox', { name: '원격 접속 켜기' })
    await typeSearch(user, dlg, '포트')
    expect(selectedTab(dlg)).toHaveAccessibleName('원격 접속')
    await user.clear(searchbox(dlg))
    expect(selectedTab(dlg)).toHaveAccessibleName('원격 접속')
    expect(panelTitle(dlg)).toHaveTextContent('원격 접속')
    // 원격 접속 내용은 내려가지 않았다(등록 코드 무효 없음 — EC-10)
    expect(fake.tauri.remotePairCancel).toHaveBeenCalledTimes(0)

    await typeSearch(user, dlg, 'ssh')
    expect(selectedTab(dlg)).toHaveAccessibleName('원격 호스트')
    expect(panelTitle(dlg)).toHaveTextContent('원격 호스트')
    await user.clear(searchbox(dlg))
    expect(selectedTab(dlg)).toHaveAccessibleName('원격 호스트')
  })

  it('EC-03 원격 브라우저(remote)에는 원격 접속·원격 CLI·서버·앱·동기화 탭이 없다', async () => {
    setup({ runtime: 'remote' })
    const dlg = await open()
    expectTabs(dlg, ['모양', '알림·표시', '에이전트', '작업 공간', '원격 호스트'])
  })

  it.each<[string, Leave]>([
    ['탭 전환', (user, dlg) => user.click(tab(dlg, '모양'))],
    [
      '검색으로 걸러짐',
      async (user, dlg) => {
        await typeSearch(user, dlg, '테마')
        await user.clear(searchbox(dlg))
      },
    ],
  ])('EC-05 원격 호스트 폼의 미저장 입력은 분류를 떠나면 버린다 — %s', async (_how, leave) => {
    const { user } = setup()
    const dlg = await open({ section: 'hosts' })
    await user.click(await within(dlg).findByRole('button', { name: '호스트 직접 등록' }))
    const form = within(dlg).getByRole('form', { name: '호스트 직접 등록' })
    await user.type(within(form).getByLabelText('이름'), 'draft-host')
    await leave(user, dlg)
    expect(selectedTab(dlg)).toHaveAccessibleName('모양')

    await user.click(tab(dlg, '원격 호스트'))
    expect(await within(dlg).findByRole('button', { name: '호스트 직접 등록' })).toBeInTheDocument()
    expect(within(dlg).queryByRole('form', { name: '호스트 직접 등록' })).toBeNull()
    expect(within(dlg).queryByDisplayValue('draft-host')).toBeNull()
  })

  it.each<[string, Leave]>([
    ['탭 전환', (user, dlg) => user.click(tab(dlg, '모양'))],
    ['검색으로 걸러짐', (user, dlg) => typeSearch(user, dlg, '테마')],
    ['닫기', (user) => user.keyboard('{Escape}')],
  ])('EC-10 원격 접속 분류를 떠나면 쓰지 않은 등록 코드를 무효로 한다 — %s', async (_how, leave) => {
    const { fake, user } = setup()
    const dlg = await open({ section: 'remote' })
    await within(dlg).findByRole('checkbox', { name: '원격 접속 켜기' })
    expect(fake.tauri.remotePairCancel).not.toHaveBeenCalled()
    await leave(user, dlg)
    await waitFor(() => expect(fake.tauri.remotePairCancel).toHaveBeenCalledTimes(1))
  })

  it('EC-17 설정 안의 중첩 대화상자(원본 위치 변경)에서 Esc 는 그 대화상자만 닫고 설정은 남는다', async () => {
    const { user } = setup()
    const dlg = await open({ section: 'workspace', target: { context: PROJECT, preview: null }, scope: PROJECT })
    await user.click(await within(dlg).findByRole('button', { name: '변경…' }))
    expect(await screen.findByRole('dialog', { name: /기준 저장소 폴더/ })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /기준 저장소 폴더/ })).toBeNull())
    expect(screen.getByRole('dialog', { name: '설정' })).toBeInTheDocument()
    expect(useSettingsPageStore.getState().open).toBe(true)
  })

  it('EC-19 한글 조합 중에는 목록·결과 수를 바로 거르고(결과 0 이면 직전 목록 유지), 분류 전환·내용 비움은 조합이 끝난 뒤', async () => {
    setup()
    const dlg = await open()
    const search = searchbox(dlg)
    const status = searchStatus(dlg, '분류 8개')

    fireEvent.compositionStart(search)
    fireEvent.input(search, { target: { value: 'ㅍ' }, isComposing: true })
    // 조합 중 결과 0 → 직전 목록·status 유지
    expectTabs(dlg, MOCK_TABS)
    expect(status).toHaveTextContent('분류 8개')
    fireEvent.input(search, { target: { value: '포' }, isComposing: true })
    expectTabs(dlg, ['원격 호스트', '원격 접속', '서버·앱'])
    expect(status).toHaveTextContent('분류 3개')
    // 보이는 분류 전환은 조합이 끝난 뒤
    expect(panelTitle(dlg)).toHaveTextContent('모양')
    fireEvent.input(search, { target: { value: '포트' }, isComposing: true })
    fireEvent.compositionEnd(search)
    await waitFor(() => expect(selectedTab(dlg)).toHaveAccessibleName('원격 호스트'))
    expect(panelTitle(dlg)).toHaveTextContent('원격 호스트')

    fireEvent.compositionStart(search)
    fireEvent.input(search, { target: { value: '포트ㅍ' }, isComposing: true })
    expectTabs(dlg, ['원격 호스트', '원격 접속', '서버·앱'])
    expect(status).toHaveTextContent('분류 3개')
    expect(panelTitle(dlg)).toHaveTextContent('원격 호스트')
    // 조합이 끝나면 결과 0 → 내용 비움(EC-01)
    fireEvent.compositionEnd(search)
    await waitFor(() => expect(within(dlg).queryByRole('tablist')).toBeNull())
    expect(within(dlg).queryByRole('tabpanel')).toBeNull()
    expect(status).toHaveTextContent('일치하는 설정이 없습니다')
  })

  it.each<[string, KeyboardEventInit]>([
    ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }],
  ])('EC-19 조합 중 Esc(%s)는 설정을 닫지 않는다', async (_by, init) => {
    setup()
    const dlg = await open()
    const search = searchbox(dlg)
    fireEvent.compositionStart(search)
    fireEvent.keyDown(search, { key: 'Escape', ...init })
    expect(screen.getByRole('dialog', { name: '설정' })).toBeInTheDocument()
    expect(useSettingsPageStore.getState().open).toBe(true)
  })

  it('EC-22 열린 채 SettingsPage 가 내려가면 설정을 닫고, 다시 그려도 저절로 열리지 않는다', async () => {
    const { view } = setup()
    await open()
    expect(useSettingsPageStore.getState().open).toBe(true)
    view.unmount()
    expect(useSettingsPageStore.getState().open).toBe(false)
    setup()
    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull()
  })
})
