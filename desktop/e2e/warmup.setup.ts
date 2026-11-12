// Vite dev 서버는 첫 요청 때 모듈을 컴파일한다(수십 초). 그 시간을 첫 테스트가 떠안아 제한 시간을 넘기지 않게 미리 한 번 연다.
import { test as setup } from '@playwright/test'

setup('dev 서버 예열', async ({ page }) => {
  setup.setTimeout(180_000)
  await page.goto('/', { waitUntil: 'load', timeout: 170_000 })
})
