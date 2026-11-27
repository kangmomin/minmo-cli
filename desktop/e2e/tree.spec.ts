// F-02 트리 (AC-03·AC-04·EC-01) + F-03 이슈 열기(AC-05, mock git)
import { expect, test } from '@playwright/test'

import { expandWidgets, GITHUB, json, login, routeGitHub, routeServer } from './fixtures'

test.beforeEach(async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  await login(page)
})

test('개인 계정이 첫 노드, 이어서 조직. gh 미사용이면 "gh 미사용(REST)" 표시', async ({ page }) => {
  const nodes = page.locator('[data-testid^="org-node-"]')
  await expect(nodes.first()).toHaveAttribute('data-testid', 'org-node-octocat')
  await expect(nodes.nth(1)).toHaveAttribute('data-testid', 'org-node-my-org')
  await expect(page.getByText('gh 미사용(REST)')).toBeVisible()
})

test('저장소를 펼치면 ★기타가 첫 행, open 이슈 표시, worktree 없는 closed 이슈는 숨김', async ({ page }) => {
  await expandWidgets(page)
  const rows = page.locator('[data-testid^="issue-row-"]')
  await expect(rows.first()).toHaveAttribute('data-testid', 'issue-row-etc')
  await expect(page.getByTestId('issue-row-42')).toContainText('Add login')
  await expect(page.getByTestId('issue-row-7')).toHaveCount(0)
})

test('이슈 열기 → 상단 바에 브랜치 표시(effective branchTemplate feat/{number}) + worktree 표시(초록 번호)', async ({ page }) => {
  await expandWidgets(page)
  await page.getByTestId('issue-row-42').click()
  await expect(page.getByTestId('issue-branch')).toHaveText('feat/42')
  await expect(page.getByTestId('issue-row-42')).toHaveAttribute('data-worktree', 'true')
})

test('이슈 등록 → 목록에 추가(선택·worktree 는 그대로)', async ({ page }) => {
  await expandWidgets(page)
  await page.getByTestId('add-issue').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('제목').fill('새 기능')
  await dialog.getByLabel('본문(선택)').fill('설명')
  await dialog.getByRole('button', { name: '등록' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('issue-row-43')).toContainText('새 기능')
  await expect(page.getByTestId('issue-row-43')).not.toHaveAttribute('data-worktree', 'true')
  await expect(page.getByTestId('issue-branch')).toHaveCount(0)
})

test('#64 머리줄에서 이슈 수정 → 머리줄·트리 제목이 바뀌고, 이유를 골라 닫으면 [닫힘](worktree 는 그대로)', async ({ page }) => {
  const patches: unknown[] = []
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().endsWith('/repos/my-org/widgets/issues/42')) patches.push(r.postDataJSON())
  })
  await expandWidgets(page)
  await page.getByTestId('issue-row-42').click()
  await expect(page.getByTestId('issue-branch')).toHaveText('feat/42')
  const header = page.getByTestId('issue-header')
  const dialog = page.getByRole('dialog')

  await header.getByRole('button', { name: '이슈 수정' }).click()
  await expect(dialog.getByLabel('본문')).toHaveValue('로그인 화면을 만든다')
  await dialog.getByLabel('제목').fill('로그인 화면')
  await dialog.getByRole('button', { name: '저장' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(header).toContainText('#42 로그인 화면')
  await expect(page.getByTestId('issue-row-42')).toContainText('로그인 화면')

  await header.getByRole('button', { name: '이슈 닫기' }).click()
  await dialog.getByRole('radio', { name: '계획 없음' }).click()
  await dialog.getByRole('button', { name: '이슈 닫기' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(header.getByTestId('issue-closed-badge')).toBeVisible()
  await expect(header.getByRole('button', { name: '이슈 닫기' })).toHaveCount(0)
  // worktree 가 있으므로 트리에 [닫힘] 으로 남는다(A-10)
  await expect(page.getByTestId('issue-row-42')).toContainText('닫힘')
  await expect(page.getByTestId('issue-row-42')).toHaveAttribute('data-worktree', 'true')
  // 바뀐 필드만 보낸다
  expect(patches).toEqual([{ title: '로그인 화면' }, { state: 'closed', state_reason: 'not_planned' }])
})

test('새로고침 버튼 → 트리 재조회', async ({ page }) => {
  let issueCalls = 0
  page.on('request', (r) => {
    if (r.url().includes('/repos/my-org/widgets/issues') && r.method() === 'GET') issueCalls++
  })
  await expandWidgets(page)
  const before = issueCalls
  await page.getByRole('button', { name: '새로고침' }).click()
  await expect.poll(() => issueCalls).toBeGreaterThan(before)
})

test('#116 [이슈] 탭 → 본문을 마크다운으로 보이고, 링크는 외부 브라우저로 연다', async ({ page }) => {
  // 이 테스트에서만 이슈 42 의 GET 을 마크다운 본문으로 덮는다(나중에 등록한 route 가 먼저). PATCH·OPTIONS 는 기본 응답으로
  await page.route(`${GITHUB}/repos/my-org/widgets/issues/42`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return json(route, 200, {
      number: 42,
      title: 'Add login',
      state: 'open',
      html_url: 'https://github.com/my-org/widgets/issues/42',
      body: '# 제목\n- 항목\n[링크](https://example.com)',
    })
  })
  await expandWidgets(page)
  await page.getByTestId('issue-row-42').click()
  await page.getByRole('tab', { name: '이슈' }).click()
  const panel = page.getByRole('tabpanel', { name: '이슈' })
  await expect(panel.getByRole('heading', { name: '제목', exact: true })).toBeVisible()
  await expect(panel.getByRole('listitem')).toContainText('항목')
  await panel.getByRole('link', { name: '링크' }).click()
  // 로그인 때 연 VERIFY_URL 이 이미 있다
  await expect.poll(() => page.evaluate(() => window.__MINMO_MOCK__?.openedUrls ?? [])).toContain('https://example.com')
})

test('#116 [이슈] 탭 — [새로고침]이면 본문을 다시 받고, [이슈 수정]으로 본문을 저장하면 새 본문을 보인다', async ({ page }) => {
  await expandWidgets(page)
  await page.getByTestId('issue-row-42').click()
  await page.getByRole('tab', { name: '이슈' }).click()
  const panel = page.getByRole('tabpanel', { name: '이슈' })
  await expect(panel.getByText('로그인 화면을 만든다')).toBeVisible()
  // 본문을 보인 뒤부터 이슈 42 GET 을 센다
  let bodyGets = 0
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === '/repos/my-org/widgets/issues/42') bodyGets++
  })
  await page.getByRole('button', { name: '새로고침' }).click()
  await expect.poll(() => bodyGets).toBeGreaterThan(0)

  const dialog = page.getByRole('dialog')
  await page.getByTestId('issue-header').getByRole('button', { name: '이슈 수정' }).click()
  await expect(dialog.getByLabel('본문')).toHaveValue('로그인 화면을 만든다')
  await dialog.getByLabel('본문').fill('비밀번호 찾기도 만든다')
  await dialog.getByRole('button', { name: '저장' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(panel.getByText('비밀번호 찾기도 만든다')).toBeVisible()
})
