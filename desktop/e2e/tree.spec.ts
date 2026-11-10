// F-02 트리 (AC-03·AC-04·EC-01) + F-03 이슈 열기(AC-05, mock git)
import { expect, test } from '@playwright/test'

import { expandWidgets, login, routeGitHub, routeServer } from './fixtures'

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

test('이슈 열기 → 상단 바에 브랜치 표시(effective branchTemplate feat/{number}) + ● 표시', async ({ page }) => {
  await expandWidgets(page)
  await page.getByTestId('issue-row-42').click()
  await expect(page.getByTestId('issue-branch')).toHaveText('feat/42')
  await expect(page.getByTestId('issue-row-42').getByLabel('worktree 있음')).toBeVisible()
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
