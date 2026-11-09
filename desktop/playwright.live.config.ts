import { defineConfig, devices } from '@playwright/test'

// 실연결 스모크(Phase 8.2): 실제 minmo 서버 + githubmock 이 이미 떠 있어야 한다(이 설정은 서버를 띄우지 않는다).
// - minmo 서버: MINMO_LIVE_SERVER (기본 http://127.0.0.1:8787) — githubmock 을 OAuth/API base 로 쓰도록 기동
// - 웹 화면: Vite dev 1420 (VITE_TAURI_MOCK=1 — Tauri 네이티브는 mock, 딥링크는 window.__MINMO_MOCK__ 로 주입)
// - GitHub REST(api.github.com)만 spec 에서 page.route 로 fixture 응답, minmo 서버 호출은 실제로 보낸다
// 실행: npm run e2e:live --workspace desktop
const LIVE_SERVER = process.env.MINMO_LIVE_SERVER ?? 'http://127.0.0.1:8787'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'live.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    // 다른 VITE_MINMO_SERVER 로 떠 있는 dev 서버를 재사용하지 않도록 항상 새로 띄운다
    reuseExistingServer: false,
    timeout: 120_000,
    env: { VITE_TAURI_MOCK: '1', VITE_MINMO_SERVER: LIVE_SERVER },
  },
})
