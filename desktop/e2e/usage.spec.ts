// 하단 바의 AI 별 사용량 — 이 PC 의 값, 원격 호스트로 바꾸면 그 호스트의 값, 설정에서 끄기
import { expect, test } from '@playwright/test'

import { login, routeGitHub, routeServer } from './fixtures'

test.beforeEach(async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  await login(page)
})

test('하단 바에 이 PC 의 사용량이 보이고, 작업 호스트를 바꾸면 그 호스트의 값으로 바뀐다', async ({ page }) => {
  const bar = page.getByTestId('usage-bar')
  await expect(bar.getByTestId('usage-host')).toHaveText('이 PC')
  // 한도를 모르는 도구는 오늘 쓴 토큰 수, 아는 도구(Codex)는 % — 80% 이상은 글자로도 알린다
  await expect(bar.getByTestId('usage-claude')).toHaveText(/Claude 1\.2M 오늘/)
  await expect(bar.getByTestId('usage-codex')).toHaveText(/Codex 5h 34% 주 85% 높음/)
  await expect(bar.getByTestId('usage-gemini')).toHaveCount(0)
  await expect(bar.getByTestId('usage-claude')).toHaveAttribute('title', /캐시에서 읽은 입력 30,000,000 \(합계에 넣지 않음\)/)

  await page.getByRole('button', { name: '원격 호스트 관리' }).click()
  await page.getByTestId('ssh-host-mock-server').getByRole('button', { name: '추가' }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('combobox', { name: '작업 호스트' }).selectOption('mock-server')
  await expect(bar.getByTestId('usage-host')).toHaveText('mock-server')
  await expect(bar.getByTestId('usage-claude')).toHaveText(/Claude 5k 오늘/)
  await expect(bar.getByTestId('usage-codex')).toHaveCount(0)

  await page.getByRole('combobox', { name: '작업 호스트' }).selectOption('')
  await expect(bar.getByTestId('usage-host')).toHaveText('이 PC')
  await expect(bar.getByTestId('usage-claude')).toHaveText(/Claude 1\.2M 오늘/)
})

test('설정에서 끄면 하단 바가 사라지고 다시 불러와도 유지된다', async ({ page }) => {
  await expect(page.getByTestId('usage-bar')).toBeVisible()
  await page.getByRole('button', { name: '서버 설정' }).click()
  await page.getByRole('checkbox', { name: '하단 바에 AI 별 사용량 표시' }).uncheck()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('usage-bar')).toHaveCount(0)
  await page.reload()
  await expect(page.getByText('minmo', { exact: true })).toBeVisible()
  await expect(page.getByTestId('usage-bar')).toHaveCount(0)
})
