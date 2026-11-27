import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { expandWidgets, json, login, openTerminal, routeGitHub, routeServer } from './fixtures'

const title = (t: string) => `\x1b]0;${t}\x07`
const emit = (page: Page, n: number, data: string) => page.evaluate(([i, d]) => window.__MINMO_MOCK__!.emitPty(i as number, d as string), [n, data] as const)
const processes = (page: Page, n: number, names: string[]) => page.evaluate(([i, p]) => window.__MINMO_MOCK__!.setPtyProcesses(i as number, p as string[]), [n, names] as const)
const counts = (page: Page) =>
  page.evaluate(() => {
    const m = window.__MINMO_MOCK__!
    return { writes: m.ptyWrites.length, spawns: m.ptySpawns, finds: m.ptyFinds, resizes: m.ptyResizes }
  })
const writeIds = (page: Page) => page.evaluate(() => [...window.__MINMO_MOCK__!.ptyWriteIds])

const list = (page: Page) => page.getByRole('navigation', { name: '세션 목록' })
const rows = (page: Page) => list(page).getByTestId('answer-row')
const card = (page: Page) => page.getByTestId('answer-summary')
const heading = (page: Page) => card(page).getByRole('heading', { name: '세션 요약' })
const answerButton = (page: Page) => page.getByTestId('answer-focus-terminal')
const terminalInput = (page: Page) => page.locator('[data-testid="terminal-pane"]:visible').getByLabel('터미널 입력')
const header = (page: Page) => page.getByTestId('issue-header')

async function claudeSession(page: Page, row: string, n: number, name: string) {
  await page.getByTestId(row).click()
  await openTerminal(page)
  await expect(page.locator('[data-testid="terminal-pane"]:visible')).toContainText('minmo mock terminal')
  await processes(page, n, ['claude.exe'])
  await emit(page, n, title(`◐ ${name}`))
  await emit(page, n, title(`✳ ${name}`))
  await expect(page.locator('[data-testid="pane-agent"]:visible')).toContainText('Claude Code · 대기 중')
}

async function twoSessions(page: Page) {
  await claudeSession(page, 'issue-row-42', 1, '로그인 수정')
  await claudeSession(page, 'issue-row-etc', 2, '문서 정리')
  await page.getByRole('button', { name: '답변 모드' }).click()
  await expect(rows(page)).toHaveCount(2)
  await expect(header(page)).toContainText('기타')
}

const worktreeOf = (page: Page, issueId: string) =>
  page.evaluate((id) => (JSON.parse(localStorage.getItem('minmo-ui') ?? '{}').state.worktreePathMap as Record<string, { path: string }>)[id].path, issueId)

test.beforeEach(async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
})

test('EC-18 AC-01 AC-02 AC-09 토글: 목록·카드·터미널 하나, 카드 내용이 바뀌어도 PTY 크기 그대로, 켜고 꺼도 터미널을 다시 만들지 않는다', async ({ page }) => {
  await login(page)
  await expandWidgets(page)
  await claudeSession(page, 'issue-row-42', 1, '로그인 수정')
  const reply = JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: '로그인을 고쳤습니다.\n테스트를 돌렸습니다.' }] } })
  const cwd = await worktreeOf(page, 'my-org/widgets#42')
  await page.evaluate(([c, t]) => window.__MINMO_MOCK__!.setClaudeReply(c, { tail: `${t}\n`, updatedMs: Date.now() }), [cwd, reply] as const)
  const before = await counts(page)

  const toggle = page.getByRole('button', { name: '답변 모드' })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('complementary', { name: '답변 모드' })).toContainText('기다리는 세션 1')
  await expect(page.getByRole('complementary', { name: '이슈 트리' })).toBeHidden()
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await expect(card(page)).toContainText('#42 Add login')
  await expect(page.getByTestId('claude-reply')).toContainText('로그인을 고쳤습니다.')
  await expect(terminalInput(page)).toHaveCount(1)

  await page.waitForTimeout(1000)
  const settled = await counts(page)
  // Why: 토글은 터미널 높이를 바꾼다 — 크기 알림이 오르는 것을 먼저 봐야 아래 '그대로' 가 빈 단언이 아니다.
  expect(settled.resizes).toBeGreaterThan(before.resizes)
  await emit(page, 1, title('◐ 로그인 수정'))
  await expect(card(page)).toContainText('작업 중')
  await emit(page, 1, title('✳ 로그인 수정'))
  await expect(card(page)).toContainText('대기 중')
  await page.waitForTimeout(2500)
  expect((await counts(page)).resizes).toBe(settled.resizes)

  await toggle.click()
  await expect(page.getByRole('complementary', { name: '이슈 트리' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '터미널' })).toHaveAttribute('aria-selected', 'true')
  await toggle.click()
  await toggle.click()
  await expect(page.getByTestId('issue-row-42')).toBeVisible()
  const after = await counts(page)
  expect([after.spawns, after.finds]).toEqual([before.spawns, before.finds])
})

test('AC-05 EC-25 답을 보내 작업 중이 되면 2초 뒤 다음 세션 — 포커스는 카드 제목, 이어 친 글자·Space·Enter 는 어느 PTY 로도 가지 않고, Tab → [이 세션에 답하기] → Enter 뒤에는 새 PTY 로만 간다', async ({ page }) => {
  await login(page)
  await expandWidgets(page)
  await twoSessions(page)
  await answerButton(page).click()
  await expect(terminalInput(page)).toBeFocused()
  await page.keyboard.type('yes')
  await page.keyboard.press('Enter')
  await emit(page, 2, title('◐ 문서 정리'))

  await expect(header(page)).toContainText('#42 Add login', { timeout: 8000 })
  await expect(heading(page)).toBeFocused()
  await expect(page.getByTestId('answer-announce')).toContainText('다음 세션: my-org/widgets #42 Add login — 대기 중')
  const { writes } = await counts(page)
  await page.keyboard.type('a b')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  expect((await counts(page)).writes).toBe(writes)

  await page.keyboard.press('Tab')
  await expect(answerButton(page)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(terminalInput(page)).toBeFocused()
  await page.keyboard.type('ok')
  await expect.poll(async () => (await writeIds(page)).slice(writes)).toEqual(['mock-pty-1', 'mock-pty-1'])
})

test('EC-09 작업 중이 되고 0.5초 뒤 Shift+Enter 로 이어서 치면 3초 뒤에도 같은 세션이다', async ({ page }) => {
  await login(page)
  await expandWidgets(page)
  await twoSessions(page)
  await answerButton(page).click()
  await expect(terminalInput(page)).toBeFocused()
  await page.keyboard.type('yes')
  await page.keyboard.press('Enter')
  await emit(page, 2, title('◐ 문서 정리'))
  await page.waitForTimeout(500)
  await page.keyboard.press('Shift+Enter')
  await page.waitForTimeout(3000)
  await expect(header(page)).toContainText('기타')
  await expect(terminalInput(page)).toBeFocused()
})

test('EC-07 에이전트가 끝나면(입력 없음) 다음 세션으로 간다 — 포커스는 터미널에서 카드 제목으로', async ({ page }) => {
  await login(page)
  await expandWidgets(page)
  await twoSessions(page)
  await answerButton(page).click()
  await expect(terminalInput(page)).toBeFocused()
  await processes(page, 2, [])
  await expect(header(page)).toContainText('#42 Add login', { timeout: 10_000 })
  await expect(heading(page)).toBeFocused()
  await expect(rows(page)).toHaveCount(1)
})

test('EC-07 에이전트가 끝난 뒤 셸에 입력하면 그 세션에 머문다', async ({ page }) => {
  await login(page)
  await expandWidgets(page)
  await twoSessions(page)
  await answerButton(page).click()
  await expect(terminalInput(page)).toBeFocused()
  await processes(page, 2, [])
  // Why: 끝남을 알아챈 때를 기다렸다 치면 1초 확인과 경주한다 — 알아채기 전부터 계속 친다.
  let afterGone = 0
  for (let i = 0; i < 40 && afterGone < 3; i++) {
    await page.keyboard.type('x')
    await page.waitForTimeout(400)
    if ((await rows(page).count()) === 1) afterGone += 1
  }
  expect(afterGone).toBe(3)
  await page.waitForTimeout(3000)
  await expect(header(page)).toContainText('기타')
  await expect(card(page)).toContainText('에이전트가 아직 없습니다')
  await expect(terminalInput(page)).toBeFocused()
})

test('AC-07 EC-08 EC-25 [건너뛰기]에서 Enter 3번은 세션을 번갈아 보이고 포커스는 그대로(ptyWrite 0회) · [이 세션에 답하기]에서 Enter 를 누른 채 두었다 떼면 그 터미널로 간다(ptyWrite 0회)', async ({ page }) => {
  await login(page)
  await expandWidgets(page)
  await twoSessions(page)
  const skip = page.getByTestId('answer-skip')
  await skip.focus()
  const { writes } = await counts(page)
  for (const next of ['#42 Add login', '기타', '#42 Add login']) {
    await page.keyboard.press('Enter')
    await expect(header(page)).toContainText(next)
    await expect(skip).toBeFocused()
  }
  await expect(page.getByTestId('answer-announce')).toContainText('다음 세션: my-org/widgets #42 Add login — 대기 중')

  await answerButton(page).focus()
  await page.keyboard.down('Enter')
  await page.keyboard.down('Enter')
  await page.keyboard.up('Enter')
  await expect(terminalInput(page)).toBeFocused()
  await page.waitForTimeout(300)
  expect((await counts(page)).writes).toBe(writes)
})

test('EC-15 Ctrl+Shift+M 은 카드 제목으로 · 누른 자리가 사라지면(설정·[에이전트 실행] 대화상자를 닫음) 포커스는 카드 제목으로 간다', async ({ page }) => {
  await login(page)
  await expandWidgets(page)
  await claudeSession(page, 'issue-row-42', 1, '로그인 수정')
  await page.getByRole('button', { name: '답변 모드' }).click()
  await answerButton(page).click()
  await expect(terminalInput(page)).toBeFocused()
  await page.keyboard.press('Control+Shift+M')
  await expect(heading(page)).toBeFocused()

  const dialog = page.getByRole('dialog', { name: '새 세션' })
  await list(page).getByTestId('answer-new-session').click()
  // Why: 대화상자 트리는 기본 보기 트리의 펼침을 같이 쓴다 — 다시 펼치면 오히려 접힌다.
  await dialog.getByTestId('issue-row-42').click()
  const launch = page.getByRole('dialog', { name: '에이전트 실행' })
  await expect(launch).toBeVisible()
  await launch.getByRole('button', { name: '취소' }).click()
  await expect(launch).toBeHidden()
  await expect(heading(page)).toBeFocused()

  await list(page).getByTestId('answer-new-session').click()
  await dialog.getByTestId('repo-node-my-org/widgets').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '프로젝트 설정' }).click()
  const settings = page.getByRole('dialog').filter({ hasText: '비워 두면 상위 설정을 상속합니다' })
  await expect(settings).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await expect(heading(page)).toBeFocused()
})

test('AC-10 AC-11 EC-15 EC-18 Jev: 서버 설정에서 켜고 키를 저장·지우면 키 상태가 따른다, [Jev 판정] → 칩 3개(PTY 크기 그대로) · 키가 없어져 버튼이 사라지면 포커스는 카드 제목', async ({ page }) => {
  await login(page)
  await expandWidgets(page)
  await claudeSession(page, 'issue-row-42', 1, '로그인 수정')

  await page.getByRole('button', { name: '서버 설정' }).click()
  const server = page.getByRole('dialog', { name: '서버 설정' })
  await server.getByRole('checkbox', { name: 'Jev 판정 버튼 보이기' }).check()
  const key = server.getByLabel('Jev API 키', { exact: true })
  await key.fill('tsk-e2e')
  await server.getByRole('button', { name: 'Jev API 키 저장' }).click()
  await expect(server.getByText('키체인: 저장됨')).toBeVisible()
  await server.getByRole('button', { name: 'Jev API 키 지우기' }).click()
  await expect(server.getByText('키체인: 없음')).toBeVisible()
  await key.fill('tsk-e2e')
  await key.press('Enter')
  await expect(server.getByText('키체인: 저장됨')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(server).toBeHidden()

  const response = {
    model: 'jev-latest',
    usage: { input_tokens: 10, output_tokens: 3 },
    answers: {
      need: { type: 'choice', choice: 'permission', confidence: 0.8, probabilities: { permission: 0.9, question: 0.05, next_task: 0.03, error: 0.01, none: 0.01 } },
      outcome: { type: 'choice', choice: 'partial', confidence: 0.6, probabilities: { success: 0.2, partial: 0.7, failed: 0.05, unknown: 0.05 } },
      urgency: { type: 'score', score: 1.6, confidence: 0.7, legend: { 0: 'low', 1: 'medium', 2: 'high' }, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 } },
    },
  }
  await page.evaluate((r) => window.__MINMO_MOCK__!.setJevResponse(r), JSON.stringify(response))
  await page.getByRole('button', { name: '답변 모드' }).click()
  const box = page.getByTestId('jev-verdict')
  const decide = box.getByRole('button', { name: 'Jev 판정' })
  await expect(decide).toBeVisible()
  await page.waitForTimeout(1000)
  const settled = await counts(page)
  await decide.click()
  await expect(box).toContainText('필요한 것: 권한 허용')
  await expect(box).toContainText('결과: 일부 끝남')
  await expect(box).toContainText('급함: 높음')
  await expect(box).toContainText('90%')
  const bodies = await page.evaluate(() => window.__MINMO_MOCK__!.jevBodies)
  expect(bodies).toHaveLength(1)
  expect((JSON.parse(bodies[0]) as { state: string }).state).toContain('minmo mock terminal')
  await page.waitForTimeout(1000)
  expect((await counts(page)).resizes).toBe(settled.resizes)

  await page.evaluate(() => window.__MINMO_MOCK__!.setJevResponse({ error: 'jev_key_missing' }))
  await decide.focus()
  await page.keyboard.press('Enter')
  await expect(decide).toHaveCount(0)
  await expect(box).toContainText('API 키')
  await expect(heading(page)).toBeFocused()
})

test('AC-12 [새 세션] → 트리 대화상자 → 이슈 → [에이전트 실행] → 새 패널이 지금 세션이 되고, 다른 세션이 기다려도 머문다', async ({ page }) => {
  await login(page)
  await expandWidgets(page)
  await claudeSession(page, 'issue-row-42', 1, '로그인 수정')
  await page.getByRole('button', { name: '답변 모드' }).click()
  await expect(header(page)).toContainText('#42 Add login')

  const dialog = page.getByRole('dialog', { name: '새 세션' })
  await list(page).getByTestId('answer-new-session').click()
  await dialog.getByTestId('issue-row-etc').click()
  await expect(dialog).toBeHidden()
  const launch = page.getByRole('dialog', { name: '에이전트 실행' })
  await expect(launch).toBeVisible()
  await launch.getByLabel('지시문').fill('')
  await launch.getByRole('button', { name: '실행' }).click()
  await expect(launch).toBeHidden()
  await expect(header(page)).toContainText('기타')
  await expect.poll(() => page.evaluate(() => window.__MINMO_MOCK__!.ptyWrites)).toEqual(['claude\r'])
  expect(await writeIds(page)).toEqual(['mock-pty-2'])

  await processes(page, 2, ['claude.exe'])
  await emit(page, 2, title('◐ 새 작업'))
  await emit(page, 2, title('✳ 새 작업'))
  await expect(rows(page)).toHaveCount(2)
  await page.waitForTimeout(3500)
  await expect(header(page)).toContainText('기타')
  await expect(list(page).locator('[data-testid="answer-row"][aria-current="true"]')).toContainText('기타')
})

test('EC-13 320px: 목록과 작업 화면을 하나씩, 카드는 높이를 줄이고 버튼은 카드 스크롤 안 · [새 세션] 대화상자는 가로로 넘치지 않는다', async ({ page }) => {
  // Why: 긴 제목이 있어야 좁은 대화상자에서 트리가 가로로 넘치는지 드러난다.
  const issue = (number: number, title: string, state = 'open') => ({ number, title, state, html_url: `https://github.com/my-org/widgets/issues/${number}`, body: '' })
  await page.route(
    (url) => url.hostname === 'api.github.com' && url.pathname === '/repos/my-org/widgets/issues',
    (route) => (route.request().method() === 'GET' ? json(route, 200, [issue(42, 'Add login'), issue(7, 'Old bug', 'closed'), issue(99, '아주 긴 이슈 제목 '.repeat(12).trim())]) : route.fallback()),
  )
  await page.setViewportSize({ width: 320, height: 720 })
  await login(page)
  await expandWidgets(page)
  await claudeSession(page, 'issue-row-42', 1, '로그인 수정')
  await page.getByRole('button', { name: '답변 모드' }).click()

  const box = await card(page).boundingBox()
  expect(box?.height).toBeCloseTo(96, 0)
  const scroller = card(page).locator(':scope > div')
  expect(await scroller.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  for (const button of [answerButton(page), page.getByTestId('answer-skip'), card(page).getByRole('button', { name: '새 세션' })]) {
    await button.scrollIntoViewIfNeeded()
    const b = (await button.boundingBox())!
    expect(b.height).toBeGreaterThanOrEqual(24)
    expect(b.y).toBeGreaterThanOrEqual(box!.y - 0.5)
    expect(b.y + b.height).toBeLessThanOrEqual(box!.y + box!.height + 0.5)
    expect(b.x + b.width).toBeLessThanOrEqual(320)
  }

  await page.getByRole('button', { name: '세션 목록 보기' }).click()
  await expect(page.getByRole('button', { name: '작업 화면 보기' })).toHaveAttribute('aria-pressed', 'true')
  await expect(list(page)).toBeVisible()
  await expect(card(page)).toBeHidden()
  expect((await page.getByRole('complementary', { name: '답변 모드' }).boundingBox())?.width).toBeCloseTo(320, 0)

  await list(page).getByTestId('answer-new-session').click()
  const dialog = page.getByRole('dialog', { name: '새 세션' })
  await expect(dialog.getByTestId('issue-row-99')).toBeVisible()
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  expect(((await dialog.boundingBox())?.x ?? 0) + ((await dialog.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(320)
})
