// 원격 접속 — 이 PC 의 설정 화면(켜기·기기 등록 코드·기기 끊기)과 휴대폰 크기 배치 (mock).
// 실제 호스트 서버·다른 기기의 접속은 Rust 테스트(src-tauri/src/remote.rs)와 실제 앱 검증으로 본다.
import { devices, expect, test } from '@playwright/test'

import { expandWidgets, login, routeGitHub, routeServer } from './fixtures'

test.beforeEach(async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  await login(page)
})

test('원격 접속 설정: 켜면 접속 주소가 보이고, [기기 등록] 이 1회용 코드를 띄우며, 등록된 기기를 끊는다', async ({ page }) => {
  await page.getByRole('button', { name: '원격 접속', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '원격 접속' })
  const toggle = dialog.getByRole('checkbox', { name: '원격 접속 켜기' })
  await expect(toggle).not.toBeChecked()
  await expect(dialog.getByRole('button', { name: '기기 등록' })).toHaveCount(0)
  await toggle.check()
  await expect(dialog.getByText('http://127.0.0.1:8790')).toBeVisible()
  await expect(dialog.getByText(/LAN 연결은 암호화되지 않습니다/)).toBeVisible()
  await dialog.getByRole('button', { name: '기기 등록' }).click()
  await expect(dialog.getByTestId('pair-code')).toHaveText('123456')
  await expect(dialog.getByText(/초 남음 · 한 번만 쓸 수 있습니다/)).toBeVisible()

  await expect(dialog.getByTestId('remote-device')).toContainText('내 휴대폰')
  await dialog.getByRole('button', { name: '끊기' }).click()
  await expect(dialog.getByText('등록된 기기가 없습니다.')).toBeVisible()
})

test.describe('휴대폰 크기', () => {
  test.use({ viewport: devices['iPhone 13'].viewport, hasTouch: true, isMobile: true })

  test('목록과 작업 화면을 한 번에 하나만 보이고, 터미널에는 키 줄이 뜨며 패널은 하나씩 본다', async ({ page }) => {
    await expandWidgets(page)
    // 처음에는 목록이 화면을 채운다
    await expect(page.getByTestId('issue-row-42')).toBeVisible()
    await page.getByTestId('issue-row-42').click()
    // 이슈를 고르면 작업 화면으로 넘어가고 목록은 가려진다
    await expect(page.getByTestId('issue-branch')).toBeVisible()
    await expect(page.getByTestId('issue-row-42')).toBeHidden()
    await expect(page.locator('[data-testid="terminal-pane"]:visible')).toContainText('minmo mock terminal')

    // 화면 키보드에 없는 키를 누를 수 있다
    const keys = page.getByTestId('terminal-key-bar')
    await expect(keys).toBeVisible()
    await keys.getByRole('button', { name: 'Esc' }).click()
    await keys.getByRole('button', { name: 'Ctrl+C' }).click()
    await keys.getByRole('button', { name: '줄바꿈(전송하지 않음)' }).click()
    await expect.poll(() => page.evaluate(() => window.__MINMO_MOCK__!.ptyWrites)).toEqual(['\x1b', '\x03', '\x1b\r'])

    // 패널을 나눠도 한 번에 하나만 크게 보이고, 번호 버튼으로 바꾼다
    await page.evaluate(() => window.__MINMO_MOCK__!.ptyWrites.splice(0))
    await page.getByLabel('터미널 입력').first().focus()
    await page.keyboard.press('Control+d')
    const tabs = page.getByRole('tablist', { name: '터미널 패널' }).getByRole('tab')
    await expect(tabs).toHaveCount(2)
    await expect(page.locator('[data-testid="terminal-pane"]:visible')).toHaveCount(1)
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await tabs.nth(0).click()
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[data-testid="terminal-pane"]:visible')).toHaveCount(1)

    // 변경·파일 탭은 위아래로 쌓는다(목록 위, 내용 아래) — 좌우로 끼우면 둘 다 못 쓴다
    await page.getByRole('tab', { name: '파일' }).click()
    await page.getByText('README.md').click()
    const tree = await page.getByRole('tree', { name: '파일' }).boundingBox()
    const editor = await page.getByTestId('code-editor').boundingBox()
    expect(editor!.y).toBeGreaterThanOrEqual(tree!.y + tree!.height - 1)
    expect(editor!.width).toBeGreaterThan(300)
    await page.getByRole('tab', { name: '변경' }).click()
    const diff = await page.getByLabel('diff').boundingBox()
    expect(diff!.width).toBeGreaterThan(300)
    await page.getByRole('tab', { name: '터미널' }).click()

    // 목록으로 돌아간다
    await page.getByRole('button', { name: '이슈 목록 보기' }).click()
    await expect(page.getByTestId('issue-row-42')).toBeVisible()
    await expect(page.getByTestId('issue-branch')).toBeHidden()
    // 가로로 넘치지 않는다
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  })
})
