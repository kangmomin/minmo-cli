// #91 이슈 테이커 — 저장소 줄 메뉴·버튼, 설정 대화상자, 배지, 단계 검사, 중단됨 표시를 실제 브라우저로 확인한다
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { login, routeGitHub, routeServer } from './fixtures'

const REPO_KEY = 'my-org/widgets'

test.beforeEach(async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  await login(page)
  await page.getByTestId('org-node-my-org').click()
  await expect(page.getByTestId('repo-node-my-org/widgets')).toBeVisible()
})

const dialog = (page: Page) => page.getByRole('dialog', { name: '이슈 테이커 — widgets' })
const saveButton = (page: Page) => dialog(page).getByRole('button', { name: '저장' })

/** 펼침 상태가 저장되어 있으면 이미 보인다 — 접힌 때만 펼친다 */
async function showWidgets(page: Page) {
  const repo = page.getByTestId('repo-node-my-org/widgets')
  await expect(page.getByTestId('org-node-my-org')).toBeVisible()
  const restored = await repo.waitFor({ timeout: 3000 }).then(
    () => true,
    () => false,
  )
  if (!restored) await page.getByTestId('org-node-my-org').click()
  await expect(repo).toBeVisible()
}

async function openFromMenu(page: Page) {
  await page.getByTestId('repo-node-my-org/widgets').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '이슈 테이커…' }).click()
  await expect(dialog(page)).toBeVisible()
}

test('AC-01 저장소 줄을 우클릭해 "이슈 테이커…" 를 누르면 대화상자가 열린다', async ({ page }) => {
  await page.getByTestId('repo-node-my-org/widgets').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '이슈 테이커…' })).toBeVisible()
  await page.getByRole('menuitem', { name: '이슈 테이커…' }).click()
  await expect(dialog(page)).toBeVisible()
})

test('UI-1 줄의 "widgets 이슈 테이커" 버튼을 키보드(Enter)로 눌러도 열린다', async ({ page }) => {
  const button = page.getByRole('button', { name: 'widgets 이슈 테이커' })
  await button.focus()
  await expect(button).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog(page)).toBeVisible()
})

test('AC-02 처음 열면 켜기 꺼짐·내가 쓴 이슈만·catch-up 꺼짐·기본 단계 2개', async ({ page }) => {
  await openFromMenu(page)
  const d = dialog(page)
  await expect(d.getByRole('checkbox', { name: '켜기' })).not.toBeChecked()
  await expect(d.getByRole('radio', { name: '내가 쓴 이슈만' })).toBeChecked()
  await expect(d.getByRole('checkbox', { name: '앱이 꺼진 동안 열린 이슈도 실행' })).not.toBeChecked()
  await expect(d.locator('fieldset')).toHaveCount(2)
  await expect(d.getByRole('group', { name: '1단계' }).getByLabel('명령')).toHaveValue('claude {prompt}')
  await expect(d.getByRole('group', { name: '1단계' }).getByLabel('지시문')).toHaveValue('/common:ready-for-impl {issue}')
  await expect(d.getByRole('group', { name: '2단계' }).getByLabel('명령')).toHaveValue('claude --continue {prompt}')
  await expect(d.getByRole('group', { name: '2단계' }).getByLabel('지시문')).toHaveValue('/common:start-workflow 위 Spec으로 구현')
})

test('AC-03 켜고 저장하면 대화상자가 닫히고 [테이커] 배지가 보이며, 다시 불러와도 남는다', async ({ page }) => {
  const badge = page.getByTestId('repo-node-my-org/widgets').getByText('테이커', { exact: true })
  await expect(badge).toHaveCount(0)
  await openFromMenu(page)
  await dialog(page).getByRole('checkbox', { name: '켜기' }).check()
  await saveButton(page).click()
  await expect(dialog(page)).toBeHidden()
  await expect(badge).toBeVisible()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('minmo-taker') ?? '{}').state?.repos?.['my-org/widgets']?.enabled ?? null)).toBe(true)

  await page.reload()
  await showWidgets(page)
  await expect(badge).toBeVisible()
})

test('AC-15·EC-09·EC-10 단계를 추가하면 3개, 빈 명령은 오류와 저장 비활성, 모두 지우면 안내', async ({ page }) => {
  await openFromMenu(page)
  const d = dialog(page)
  await d.getByRole('button', { name: '단계 추가' }).click()
  await expect(d.locator('fieldset')).toHaveCount(3)
  await expect(saveButton(page)).toBeEnabled()

  // 새 단계의 명령을 비우면 오류가 보이고 저장할 수 없다
  const command = d.getByRole('group', { name: '3단계' }).getByLabel('명령')
  await command.fill('')
  await expect(d.locator('fieldset [role=alert]').first()).toBeVisible()
  await expect(saveButton(page)).toBeDisabled()

  // 모든 단계를 지우면 "단계를 하나 이상 두세요"
  for (let n = 3; n >= 1; n--) await d.getByRole('button', { name: `${n}단계 삭제` }).click()
  await expect(d.locator('fieldset')).toHaveCount(0)
  await expect(d.getByText('단계를 하나 이상 두세요')).toBeVisible()
  await expect(saveButton(page)).toBeDisabled()
})

test('EC-06 앱이 꺼질 때 실행 중이던 실행은 다시 열면 "중단됨" 으로 보인다', async ({ page }) => {
  // 앱이 저장 값을 읽기 전에 넣는다 — 새로 불러올 때마다 다시 넣지 않도록 sessionStorage 로 한 번만
  await page.addInitScript(
    ({ key }) => {
      if (sessionStorage.getItem('e2e-taker-seeded') !== null) return
      sessionStorage.setItem('e2e-taker-seeded', '1')
      const step = { kind: 'claude', command: 'claude {prompt}', prompt: '/common:ready-for-impl {issue}' }
      const run = {
        id: `${key}#42-1`,
        repoKey: key,
        owner: 'my-org',
        repo: 'widgets',
        number: 42,
        title: 'Add login',
        url: 'https://github.com/my-org/widgets/issues/42',
        issueId: null,
        steps: [step],
        step: 0,
        status: 'running',
        paneId: null,
        assigned: false,
        note: null,
        error: null,
        foundAt: 1,
        updatedAt: 1,
      }
      localStorage.setItem('minmo-taker', JSON.stringify({ state: { repos: {}, taken: {}, runs: [run] }, version: 1 }))
    },
    { key: REPO_KEY },
  )
  await page.reload()
  await showWidgets(page)
  await openFromMenu(page)
  const item = dialog(page).getByRole('listitem').filter({ hasText: '#42 Add login' })
  await expect(item).toBeVisible()
  await expect(item.getByText('중단됨', { exact: true })).toBeVisible()
  await expect(item.getByText('실행 중', { exact: true })).toHaveCount(0)
})
