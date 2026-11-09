import { defineConfig, devices } from '@playwright/test'

// 웹 화면(Vite dev 1420) 대상 E2E. Tauri 네이티브 커맨드는 src/lib/tauri.mock.ts 로 대체(VITE_TAURI_MOCK=1),
// 서버·GitHub 응답은 각 spec 이 page.route 로 계약 fixture(contracts/fixtures)를 돌려준다.
export default defineConfig({
  testDir: './e2e',
  // 실연결 스모크는 실제 서버가 필요하다 → playwright.live.config.ts(npm run e2e:live)로만 실행
  testIgnore: ['**/live.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { VITE_TAURI_MOCK: '1' },
  },
})
