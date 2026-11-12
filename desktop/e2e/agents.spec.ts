// 에이전트 현황 — 터미널 출력(제목·프로세스)으로 상태를 추정해 이슈 행·패널·전체 현황에 보이고 알림을 띄운다 (mock PTY)
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { expandWidgets, login, routeGitHub, routeServer } from './fixtures'

const title = (t: string) => `\x1b]0;${t}\x07`

/** n 번째 터미널에 출력을 흘린다 */
const emit = (page: Page, n: number, data: string) => page.evaluate(([i, d]) => window.__MINMO_MOCK__!.emitPty(i as number, d as string), [n, data] as const)

test.beforeEach(async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  await login(page)
  await expandWidgets(page)
})

test('Claude Code 의 작업 중 → 끝남을 이슈 행·패널·상단 버튼에 보이고, 다른 이슈를 보는 동안 끝나면 알린다', async ({ page }) => {
  await page.getByTestId('issue-row-42').click()
  await expect(page.getByTestId('terminal-pane')).toContainText('minmo mock terminal')
  // 에이전트가 없을 때는 표시가 없다
  await expect(page.getByTestId('pane-agent')).toHaveCount(0)
  await expect(page.getByTestId('issue-row-42').getByTestId('issue-agent')).toHaveCount(0)

  await page.evaluate(() => window.__MINMO_MOCK__!.setPtyProcesses(1, ['claude.exe']))
  await emit(page, 1, title('◐ 로그인 수정'))
  await expect(page.getByTestId('pane-agent')).toHaveText('Claude Code · 작업 중 — 로그인 수정')
  await expect(page.getByTestId('issue-row-42').getByRole('img', { name: '에이전트 작업 중' })).toBeVisible()
  await expect(page.getByTestId('agents-button')).toHaveAccessibleName('에이전트 현황 — 작업 중 1 · 확인 필요 0')

  // 다른 이슈(기타)로 옮긴 뒤 #42 의 작업이 끝난다 → "끝남" + 알림
  await page.getByTestId('issue-row-etc').click()
  await expect(page.getByTestId('issue-branch')).toBeVisible()
  await emit(page, 1, title('✳ 로그인 수정'))
  await expect(page.getByTestId('issue-row-42').getByRole('img', { name: '에이전트 끝남' })).toBeVisible()
  await expect(page.getByTestId('agents-button')).toHaveAccessibleName('에이전트 현황 — 작업 중 0 · 확인 필요 1')
  expect(await page.evaluate(() => window.__MINMO_MOCK__!.notifications)).toEqual([{ title: 'Claude Code — 끝남', body: 'widgets #42 Add login' }])

  // 그 터미널을 다시 보면 "대기 중"으로 바뀐다
  await page.getByTestId('issue-row-42').click()
  await expect(page.getByTestId('issue-row-42').getByRole('img', { name: '에이전트 대기 중' })).toBeVisible()
  await expect(page.getByTestId('pane-agent').first()).toHaveText('Claude Code · 대기 중 — 로그인 수정')
})

test('전체 현황: 여러 이슈의 에이전트를 모아 보고 필터·정렬·묶기, 줄을 누르면 그 터미널로 이동한다', async ({ page }) => {
  // #42: Claude Code 작업 중, 기타: Codex(프로세스 이름으로 감지, 출력이 나오는 동안 작업 중)
  await page.getByTestId('issue-row-42').click()
  await expect(page.getByTestId('terminal-pane')).toContainText('minmo mock terminal')
  await page.evaluate(() => window.__MINMO_MOCK__!.setPtyProcesses(1, ['claude.exe']))
  await emit(page, 1, title('◐ 로그인 수정'))
  await page.getByTestId('issue-row-etc').click()
  await expect(page.locator('[data-testid="terminal-pane"]:visible')).toContainText('minmo mock terminal')
  await page.evaluate(() => window.__MINMO_MOCK__!.setPtyProcesses(2, ['node.exe', 'codex.exe']))
  await emit(page, 2, 'Thinking about the task…')
  await expect(page.locator('[data-testid="pane-agent"]:visible')).toHaveText('Codex · 작업 중', { timeout: 10_000 })

  await page.getByTestId('agents-button').click()
  const dialog = page.getByRole('dialog', { name: '에이전트 현황' })
  const rows = dialog.getByTestId('agent-row')
  await expect(rows).toHaveCount(2)
  await expect(dialog.getByRole('status')).toHaveText('2개 표시')

  // 필터: 에이전트
  await dialog.getByRole('group', { name: '에이전트' }).getByRole('button', { name: 'Codex' }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('widgets 기타')
  await expect(dialog.getByRole('status')).toHaveText('1개 표시 (전체 2개)')
  await dialog.getByRole('button', { name: '필터 지우기' }).click()
  // 검색
  await dialog.getByRole('textbox', { name: '검색' }).fill('login')
  await expect(rows).toHaveCount(1)
  await dialog.getByRole('textbox', { name: '검색' }).fill('')
  // 묶기: 에이전트별
  await dialog.getByLabel('묶기').selectOption('agent')
  await expect(dialog.getByTestId('agents-group')).toHaveText(['Claude Code (1)', 'Codex (1)'])
  // 정렬: 이름순(#42 가 기타보다 앞)
  await dialog.getByLabel('묶기').selectOption('none')
  await dialog.getByLabel('정렬').selectOption('name')
  await expect(rows.first()).toContainText('#42 Add login')

  // 줄을 누르면 그 이슈의 터미널로
  await rows.first().click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('issue-header')).toContainText('#42 Add login')
  await expect(page.locator('[data-testid="pane-agent"]:visible')).toHaveText('Claude Code · 작업 중 — 로그인 수정')

  // 고른 보기 옵션은 다시 열어도 그대로다
  await page.getByTestId('agents-button').click()
  await expect(dialog.getByLabel('정렬')).toHaveValue('name')
  await page.keyboard.press('Escape')

  // 트리 필터: 에이전트가 있는 이슈만
  await page.getByRole('button', { name: '에이전트가 있는 이슈만' }).click()
  await expect(page.getByTestId('issue-row-42')).toBeVisible()
  await expect(page.getByTestId('issue-row-etc')).toBeVisible()
  await emit(page, 2, title('minmo-not-tmux'))
  await page.evaluate(() => window.__MINMO_MOCK__!.setPtyProcesses(2, ['conhost.exe']))
  await expect(page.getByTestId('issue-row-etc')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByTestId('issue-row-42')).toBeVisible()
  // 필터는 저장하지 않는다 — 새로고침하면 꺼져 있다(에이전트 현황이 비어 트리가 비지 않게)
  await page.reload()
  await expect(page.getByRole('button', { name: '에이전트가 있는 이슈만' })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('issue-row-etc')).toBeVisible()
})

test('Claude Code 의 하위 에이전트: 패널 머리줄에 실행 중인 수, 전체 현황에 목록 — 실행 중인 것만 필터', async ({ page }) => {
  await page.getByTestId('issue-row-42').click()
  await expect(page.getByTestId('terminal-pane')).toContainText('minmo mock terminal')
  // 작업 폴더(worktree)의 경로로 세션 기록을 찾는다
  const cwd = await page.evaluate(() => {
    const map = JSON.parse(localStorage.getItem('minmo-ui') ?? '{}').state.worktreePathMap as Record<string, { path: string }>
    return Object.values(map)[0].path
  })
  await page.evaluate(
    ([path]) => {
      const meta = (agentType: string, description: string, finished: boolean) => JSON.stringify({ agentType, description, finished })
      window.__MINMO_MOCK__!.setSubagents(path, [
        { id: 'agent-a1', meta: meta('Explore', '로그인 코드 찾기', false), updatedMs: Date.now() - 20_000 },
        { id: 'agent-b2', meta: meta('general-purpose', '테스트 작성', false), updatedMs: Date.now() - 5_000 },
        { id: 'agent-c3', meta: meta('general-purpose', '끝난 리뷰', true), updatedMs: Date.now() - 90_000 },
      ])
      window.__MINMO_MOCK__!.setPtyProcesses(1, ['claude.exe'])
    },
    [cwd],
  )
  await emit(page, 1, title('◐ 로그인 수정'))
  await expect(page.getByTestId('pane-subagents')).toHaveText('· 하위 에이전트 2개 실행 중', { timeout: 10_000 })

  await page.getByTestId('agents-button').click()
  const dialog = page.getByRole('dialog', { name: '에이전트 현황' })
  const subs = dialog.getByTestId('subagent-row')
  await expect(subs).toHaveCount(3)
  // 실행 중인 것 먼저(최근 활동순), 끝난 것은 뒤
  await expect(subs.nth(0)).toContainText('테스트 작성')
  await expect(subs.nth(1)).toContainText('Explore')
  await expect(subs.nth(2)).toContainText('끝남')
  await dialog.getByLabel('정렬').selectOption('subagents')
  await dialog.getByRole('checkbox', { name: '하위 에이전트가 실행 중인 것만' }).check()
  await expect(dialog.getByTestId('agent-row')).toHaveCount(1)
  // 하위 에이전트가 모두 끝나면 필터에서 빠진다
  await page.evaluate(
    ([path]) => window.__MINMO_MOCK__!.setSubagents(path, [{ id: 'agent-a1', meta: JSON.stringify({ agentType: 'Explore', description: 'x', finished: true }), updatedMs: Date.now() }]),
    [cwd],
  )
  await expect(dialog.getByTestId('agent-row')).toHaveCount(0, { timeout: 10_000 })
  await dialog.getByRole('button', { name: '필터 지우기' }).click()
  await expect(dialog.getByTestId('agent-row')).toHaveCount(1)
})
