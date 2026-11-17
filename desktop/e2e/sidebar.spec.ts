// #70 사이드바 잘림·폭 조절 — 레이아웃(말줄임·넘침·가로 밀림)과 구분선(끌기·키보드·더블클릭·저장)은 실제 브라우저로만 확인할 수 있다
import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

import { json, login, routeGitHub, routeServer } from './fixtures'

const LONG_TITLE = '사이드바 폭보다 훨씬 긴 이슈 제목 — 한 줄로 줄이고 말줄임표를 보여야 하는 제목입니다 (#70 재현용)'
const LONG_ISSUE = 100
/** 연결할 수 없는 호스트 별칭(32자 이상) — 연결 대기 행 + 긴 호스트 배지 */
const DOWN_ALIAS = 'unreachable-build-host.example.internal'

const ghIssue = (number: number, title: string) => ({ number, title, state: 'open', html_url: `https://github.com/my-org/widgets/issues/${number}` })
// 긴 제목 1개 + 스크롤이 생기도록 open 이슈 30개(트리는 open 만 보인다)
const WIDGETS_ISSUES = [ghIssue(LONG_ISSUE, LONG_TITLE), ...Array.from({ length: 30 }, (_, i) => ghIssue(i + 1, `스크롤 확인용 이슈 ${i + 1}`))]
const ghRepo = (name: string) => ({ name, owner: { login: 'my-org' }, default_branch: 'main' })

const isGitHubPath = (path: string) => (u: URL) => u.host === 'api.github.com' && u.pathname === path
const getOnly = (body: unknown) => (route: Route) => (route.request().method() === 'GET' ? json(route, 200, body) : route.fallback())

test.beforeEach(async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  // routeGitHub 뒤에 등록한 route 가 먼저 받는다
  await page.route(isGitHubPath('/repos/my-org/widgets/issues'), getOnly(WIDGETS_ISSUES))
  await page.route(isGitHubPath('/orgs/my-org/repos'), getOnly([ghRepo('widgets'), ghRepo('gadgets'), ghRepo('doohickeys')]))
  await login(page)
  // gadgets: 연결되는 mock-server 에 묶고 기준 저장소를 정한다(호스트 배지 + 기준 저장소 배지)
  // doohickeys: 연결할 수 없는 긴 별칭에 묶는다(연결 대기 행 + 긴 호스트 배지)
  await page.evaluate(
    ({ down }) =>
      localStorage.setItem(
        'minmo-hosts',
        JSON.stringify({
          state: {
            aliases: ['mock-server'],
            selected: null,
            baseRepos: { 'ssh:mock-server': { 'my-org/gadgets': '/home/dev/src/gadgets' } },
            repoHosts: { 'my-org/gadgets': 'ssh:mock-server', 'my-org/doohickeys': `ssh:${down}` },
          },
          version: 0,
        }),
      ),
    { down: DOWN_ALIAS },
  )
  await page.reload()
  await page.getByTestId('org-node-my-org').click()
  await page.getByTestId('repo-node-my-org/widgets').click()
  await expect(page.getByTestId(`issue-row-${LONG_ISSUE}`)).toBeVisible()
})

const separator = (page: Page) => page.getByRole('separator', { name: '사이드바 폭' })
const aside = (page: Page) => page.getByRole('complementary', { name: '이슈 트리' })
const asideWidth = (page: Page) => aside(page).evaluate((el) => el.getBoundingClientRect().width)
const savedWidth = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem('minmo-ui') ?? '{}').state?.sidebarWidth as number | undefined) ?? null)

/** probe 가 끝나기 전에는 gadgets 도 연결 대기 행이다 — 측정 전에 기다린다 */
async function waitForGadgets(page: Page) {
  const gadgets = page.getByTestId('repo-node-my-org/gadgets')
  await expect(gadgets).toBeVisible()
  await expect(gadgets.getByTestId('base-repo-badge')).toBeVisible()
  await expect(page.getByTestId('repo-pending-my-org/doohickeys')).toBeVisible()
}

/** 구분선에 포커스하고 Home → 최소 폭(240) */
async function narrowest(page: Page) {
  await separator(page).focus()
  await page.keyboard.press('Home')
  await expect.poll(() => asideWidth(page)).toBe(240)
}

test('AC-01 긴 이슈 제목은 한 줄로 줄이고 … 를 보인다', async ({ page }) => {
  const title = page.getByTestId(`issue-row-${LONG_ISSUE}`).getByText(LONG_TITLE, { exact: true })
  const m = await title.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflow: getComputedStyle(el).textOverflow }))
  expect(m.scroll).toBeGreaterThan(m.client)
  expect(m.overflow).toBe('ellipsis')
})

test('AC-02 최소 폭(240)에서 배지가 있는 저장소·연결 대기 행 — 이름은 40px 이상, 배지는 행 안에서 잘리고 버튼과 겹치지 않는다', async ({ page }) => {
  await expect(separator(page)).toBeVisible()
  await narrowest(page)
  await waitForGadgets(page)
  const asideBox = (await aside(page).boundingBox())!
  const rows = [
    // 저장소 행: 이름·배지를 담은 버튼이 행 버튼들과 같은 줄(group)에 있다
    { name: 'gadgets', label: page.getByTestId('repo-node-my-org/gadgets'), group: page.getByTestId('repo-node-my-org/gadgets').locator('xpath=..') },
    // 연결 대기 행: 이름·배지를 담은 div 와 ⚙ 버튼이 같은 줄(group)에 있다
    { name: 'doohickeys', label: page.getByTestId('repo-pending-my-org/doohickeys'), group: page.getByTestId('repo-pending-my-org/doohickeys').locator(':scope > div').first() },
  ]
  for (const { name, label, group } of rows) {
    const nameEl = label.getByText(name, { exact: true })
    const nm = await nameEl.evaluate((el) => ({ width: el.clientWidth, overflow: getComputedStyle(el).textOverflow }))
    expect(nm.width, `${name} 이름 폭`).toBeGreaterThanOrEqual(40)
    expect(nm.overflow).toBe('ellipsis')

    // 헤더의 "gh 미사용(REST)" 배지는 빼고, 이 행 안의 배지만 본다
    const badges = label.locator('[data-slot=badge]')
    expect(await badges.count()).toBeGreaterThan(0)
    const buttons = group.locator(':scope > button:not([data-testid])')
    const firstButton = (await buttons.first().boundingBox())!
    for (const badge of await badges.all()) {
      expect(await badge.evaluate((el) => getComputedStyle(el.parentElement!).overflowX), `${name} 배지를 담은 칸`).toBe('hidden')
      // 보조 확인: 배지가 첫 버튼과 겹치지 않는다
      const b = (await badge.boundingBox())!
      expect(b.x + b.width).toBeLessThanOrEqual(firstButton.x)
    }
    for (const button of await buttons.all()) {
      const r = (await button.boundingBox())!
      expect(r.x + r.width).toBeLessThanOrEqual(asideBox.x + asideBox.width)
    }
  }
})

test('AC-01·AC-02 최소 폭(240)에서 닫힘·경로 변경됨 배지가 함께 있는 이슈 행 — 제목은 40px 이상, 배지는 줄고 행 안에서 잘린다', async ({ page }) => {
  // closed 이슈는 worktree 가 있을 때만 보이고, 저장된 worktree 경로가 설정(effective)으로 계산한 경로와 다르면 '경로 변경됨' 이 붙는다
  const CLOSED = 777
  const closedTitle = '닫혔지만 작업 폴더가 남아 있는 이슈 — 배지 두 개와 함께 보인다'
  await page.route(isGitHubPath('/repos/my-org/widgets/issues'), getOnly([...WIDGETS_ISSUES, { ...ghIssue(CLOSED, closedTitle), state: 'closed' }]))
  // 앱이 저장 값을 읽기 전에 넣는다 — 실행 중에 쓰면 앱의 다음 저장이 덮어쓸 수 있다
  await page.addInitScript((id) => {
    const saved = JSON.parse(localStorage.getItem('minmo-ui') ?? '{"state":{},"version":1}')
    saved.state.worktreePathMap = { ...saved.state.worktreePathMap, [id]: { path: '/elsewhere/widgets-closed', branch: 'old/branch' } }
    localStorage.setItem('minmo-ui', JSON.stringify(saved))
  }, `my-org/widgets#${CLOSED}`)
  await page.reload()
  const row = page.getByTestId(`issue-row-${CLOSED}`)
  await expect(row).toBeVisible()
  // 전제: 두 배지가 모두 있다. '경로 변경됨' 은 툴팁 trigger 가 data-slot 을 덮어써서 글자로 찾는다
  const badges = [row.getByText('닫힘', { exact: true }), row.getByText('경로 변경됨', { exact: true })]
  for (const badge of badges) await expect(badge).toBeVisible()
  await expect(separator(page)).toBeVisible()
  await narrowest(page)

  const title = row.getByText(closedTitle, { exact: true })
  const t = await title.evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth, overflow: getComputedStyle(el).textOverflow }))
  expect(t.width, '제목 폭').toBeGreaterThanOrEqual(40)
  expect(t.scroll).toBeGreaterThan(t.width)
  expect(t.overflow).toBe('ellipsis')
  // 전제: 240px 에서 배지가 다 들어가지 않는다(넘침이 실제로 생긴다) — 줄어든 배지는 … 를 보인다
  const measured = await Promise.all(
    badges.map((badge) =>
      badge.evaluate((el) => ({ shrunk: el.scrollWidth > el.clientWidth, overflow: getComputedStyle(el).textOverflow, parentOverflow: getComputedStyle(el.parentElement!).overflowX })),
    ),
  )
  expect(measured.filter((b) => b.shrunk).length, '줄어든 배지 수').toBeGreaterThan(0)
  for (const b of measured) {
    if (b.shrunk) expect(b.overflow).toBe('ellipsis')
    expect(b.parentOverflow, '배지를 담은 칸').toBe('hidden')
  }
})

test('AC-02 최소 폭(240)에서 세로 스크롤바가 행 끝 버튼(⚙)을 가리지 않는다', async ({ page }) => {
  await expect(separator(page)).toBeVisible()
  await narrowest(page)
  await page.getByTestId(`issue-row-${LONG_ISSUE}`).hover()
  const scrollbar = aside(page).locator('[data-slot=scroll-area-scrollbar][data-state=visible]')
  await expect(scrollbar).toBeVisible()
  const bar = (await scrollbar.boundingBox())!
  const gear = (await page.getByRole('button', { name: 'widgets 프로젝트 설정' }).boundingBox())!
  expect(bar.x).toBeGreaterThanOrEqual(gear.x + gear.width)
})

test('AC-03 포커스·클릭으로 목록이 가로로 밀리지 않고, 화살표 아이콘이 사이드바 안에 있다', async ({ page }) => {
  const viewport = aside(page).locator('[data-slot=scroll-area-viewport]')
  const scrollLeft = () => viewport.evaluate((el) => el.scrollLeft)
  await page.getByRole('button', { name: 'widgets 이슈 등록' }).focus()
  expect(await scrollLeft()).toBe(0)
  const row = page.getByTestId(`issue-row-${LONG_ISSUE}`)
  await row.click()
  // 행이 worktree 묶음으로 옮겨 가며 scrollIntoView 가 실행된 뒤에 잰다
  await expect(row).toHaveAttribute('data-worktree', 'true')
  expect(await scrollLeft()).toBe(0)
  await viewport.evaluate((el) => {
    el.scrollLeft = 1000
  })
  expect(await scrollLeft()).toBe(0)
  const asideX = (await aside(page).boundingBox())!.x
  for (const id of ['org-node-my-org', 'repo-node-my-org/widgets']) {
    const chevron = (await page.getByTestId(id).locator('svg').first().boundingBox())!
    expect(chevron.x, `${id} 화살표`).toBeGreaterThanOrEqual(asideX)
  }
})

test('AC-04·AC-06 구분선을 끌면 폭이 바뀌고, 놓을 때 저장해 다시 켜도 같다', async ({ page }) => {
  await expect(separator(page)).toBeVisible()
  const box = (await separator(page).boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 100, y, { steps: 5 })
  await expect.poll(() => asideWidth(page)).toBe(388)
  // 드래그 중에는 저장하지 않는다
  expect(await savedWidth(page)).not.toBe(388)
  await page.mouse.up()
  await expect.poll(() => savedWidth(page)).toBe(388)
  await page.reload()
  await expect(separator(page)).toBeVisible()
  await expect.poll(() => asideWidth(page)).toBe(388)
})

test('AC-05 트리의 마지막 컨트롤에서 Tab 한 번으로 구분선에 가고, 포커스 표시가 보인다', async ({ page }) => {
  await expect(separator(page)).toBeVisible()
  // 트리(스크롤 영역)의 마지막 컨트롤 — 보이지 않을 때만 숨기는(opacity) 행 버튼도 Tab 순서에 있다
  await aside(page).locator('[data-slot=scroll-area-viewport]').locator('button, input, select, [tabindex="0"]').last().focus()
  await page.keyboard.press('Tab')
  await expect(separator(page)).toBeFocused()
  expect(await separator(page).evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')
})

test('AC-08 더블클릭하면 기본 폭(288)으로 돌아가고 저장한다', async ({ page }) => {
  await expect(separator(page)).toBeVisible()
  await separator(page).focus()
  await page.keyboard.press('End')
  await expect.poll(() => asideWidth(page)).toBe(480)
  await separator(page).dblclick()
  await expect.poll(() => asideWidth(page)).toBe(288)
  await expect.poll(() => savedWidth(page)).toBe(288)
  await page.reload()
  await expect(separator(page)).toBeVisible()
  await expect.poll(() => asideWidth(page)).toBe(288)
})

test('EC-03 md 보다 좁으면 구분선을 숨기고 사이드바는 전체 폭 — 다시 넓히면 저장 폭', async ({ page }) => {
  await expect(separator(page)).toBeVisible()
  // 240 + 16 × 10 = 400
  await narrowest(page)
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
  await expect.poll(() => savedWidth(page)).toBe(400)
  await page.setViewportSize({ width: 600, height: 720 })
  await expect(separator(page)).toBeHidden()
  await expect.poll(() => asideWidth(page)).toBe(600)
  expect(await savedWidth(page)).toBe(400)
  await page.setViewportSize({ width: 1280, height: 720 })
  await expect(separator(page)).toBeVisible()
  await expect.poll(() => asideWidth(page)).toBe(400)
})

test('EC-05 트리 글자 위를 가로질러 끌어도 텍스트가 선택되지 않는다', async ({ page }) => {
  await expect(separator(page)).toBeVisible()
  const box = (await separator(page).boundingBox())!
  const rowBox = (await page.getByTestId(`issue-row-${LONG_ISSUE}`).boundingBox())!
  // 끌기는 구분선에서 시작한다 — 긴 제목 행 높이에서 왼쪽으로 끌어 글자 위를 지나간다
  const x = box.x + box.width / 2
  const y = rowBox.y + rowBox.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 200, y, { steps: 10 })
  await page.mouse.up()
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
})

test('회귀 가드: 스크롤바 thumb 를 끌면 폭이 아니라 스크롤이 바뀐다', async ({ page }) => {
  const viewport = aside(page).locator('[data-slot=scroll-area-viewport]')
  await page.getByTestId(`issue-row-${LONG_ISSUE}`).hover()
  const scrollbar = aside(page).locator('[data-slot=scroll-area-scrollbar][data-state=visible]')
  await expect(scrollbar).toBeVisible()
  const thumb = (await scrollbar.locator('div').first().boundingBox())!
  const before = await asideWidth(page)
  const x = thumb.x + thumb.width / 2
  const y = thumb.y + thumb.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + 100, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  expect(await asideWidth(page)).toBe(before)
})
