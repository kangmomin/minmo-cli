// E2E 큐(#92) — 이슈를 큐에 넣으면 그 이슈의 새 터미널 패널에서 역할 명령을 차례로 실행하고, 결과 파일로 다음 단계를 연다 (mock PTY·파일)
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { expandWidgets, login, openTerminal, routeGitHub, routeServer } from './fixtures'

const title = (t: string) => `\x1b]0;${t}\x07`
const emit = (page: Page, n: number, data: string) => page.evaluate(([i, d]) => window.__MINMO_MOCK__!.emitPty(i as number, d as string), [n, data] as const)
const writes = (page: Page) => page.evaluate(() => window.__MINMO_MOCK__!.ptyWrites)
const panes = (page: Page) => page.locator('[data-testid="terminal-pane"]:visible')
/** 작업 이름(버튼 이름에 들어간다) */
const JOB = /#42 Add login/
const named = (action: string) => new RegExp(`^${action} \\(.*#42 Add login\\)$`)

const CLAUDE_CATALOG = JSON.stringify({
  catalog: { catalog: { config: { models: [{ id: 'claude-opus-4-1', name: 'Opus 4.1' }, { id: 'claude-sonnet-4-5', name: 'Sonnet 4.5' }] } } },
  masked: { ids: [] },
})

/** 이 PC 의 #42 작업 폴더 */
const worktree42 = (page: Page) =>
  page.evaluate(() => (JSON.parse(localStorage.getItem('minmo-ui') ?? '{}').state.worktreePathMap as Record<string, { path: string }>)['my-org/widgets#42'].path)

/** 단계 명령에 든 결과 파일(worktree 기준 상대 경로) */
const resultOf = (command: string, name: string) => new RegExp(`\\.minmo/e2e/[A-Za-z0-9-]+/${name.replace('.', '\\.')}`).exec(command)?.[0]

async function openIssue42(page: Page) {
  await expandWidgets(page)
  await page.getByTestId('issue-row-42').click()
  await openTerminal(page)
  await expect(panes(page)).toContainText('minmo mock terminal')
}

test.beforeEach(async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  await login(page)
})

test('AC-01~06·09·12 A-12 큐에 넣으면 새 패널에서 ①을 실행하고, 결과 파일이 생기고 에이전트가 쉬면 ②로, [다음 단계]로 ③·완료 — 쓰던 패널의 포커스는 그대로', async ({ page }) => {
  test.setTimeout(90_000)
  await page.evaluate((raw) => window.__MINMO_MOCK__!.setAgentModels('claude', raw), CLAUDE_CATALOG)
  await openIssue42(page)

  // AC-10·11: ① 의 모델을 목록에서 고른다
  await page.getByTestId('e2e-queue-button').click()
  const dialog = page.getByRole('dialog', { name: 'E2E 큐' })
  await dialog.getByRole('tab', { name: '역할 설정' }).click()
  const run = dialog.getByRole('group', { name: '① E2E 실행' })
  await expect(run.getByRole('status')).toHaveText('모델 2개')
  await run.getByLabel('모델', { exact: true }).selectOption('claude-opus-4-1')
  await page.keyboard.press('Escape')

  // AC-01: 작업 폴더가 준비된 이슈의 머리줄에서 큐에 넣는다
  await page.getByRole('button', { name: 'E2E 큐에 추가' }).click()
  await expect(page.getByTestId('e2e-enqueue-status')).toHaveText('E2E 큐에 추가했습니다')
  // AC-02·03·04: 바로 시작 — 새 패널(두 번째 터미널)에 모델 인자 + 지시문(결과 파일 경로 포함)이 들어간다
  await expect(panes(page)).toHaveCount(2, { timeout: 10_000 })
  await expect.poll(() => writes(page), { timeout: 10_000 }).toHaveLength(1)
  const first = (await writes(page))[0]
  expect(first).toMatch(/^claude --model 'claude-opus-4-1' '이슈 #42 Add login \(https:\/\/github\.com\/my-org\/widgets\/issues\/42\) 의 작업 폴더에서 E2E 테스트를 실행한다\./)
  const out1 = resultOf(first, '1-run.md')
  expect(out1).toBeTruthy()
  // A-12: 큐가 연 패널은 포커스를 옮기지 않는다 — 쓰던 첫 패널이 그대로 골라져 있고, 키보드 포커스도 누른 버튼에 남는다
  await expect(panes(page).nth(0)).toHaveClass(/outline-ring/)
  await expect(panes(page).nth(1)).not.toHaveClass(/outline-ring/)
  await expect(page.getByRole('button', { name: 'E2E 큐에 추가' })).toBeFocused()
  // EC-04: 실행 중인 이슈는 다시 넣지 않는다
  await page.getByRole('button', { name: 'E2E 큐에 추가' }).click()
  await expect(page.getByTestId('e2e-enqueue-status')).toHaveText('이미 E2E 큐에서 대기·실행 중입니다')
  await expect(page.getByTestId('e2e-queue-button')).toHaveAccessibleName('E2E 큐 (1)')

  // AC-12: 작업 행에 이슈 이름·상태
  await page.getByTestId('e2e-queue-button').click()
  const row = dialog.getByTestId('e2e-job')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(JOB)
  await expect(row.getByTestId('e2e-job-status')).toHaveText('실행 중 1/3 ① E2E 실행')
  await page.keyboard.press('Escape')

  // AC-05: 에이전트가 결과 파일을 쓰고 쉰다 → ② 가 새 패널에서 시작(앞 단계 결과 파일을 지시문에 넣는다)
  const root = await worktree42(page)
  await page.evaluate(() => window.__MINMO_MOCK__!.setPtyProcesses(2, ['claude.exe']))
  await emit(page, 2, title('✳ E2E 실행'))
  await page.evaluate(([r, rel]) => window.__MINMO_MOCK__!.putTextFile(r, rel, '# ① 결과\n통과 3, 실패 0\n'), [root, out1!] as const)
  await expect.poll(() => writes(page), { timeout: 20_000 }).toHaveLength(2)
  const second = (await writes(page))[1]
  expect(resultOf(second, '2-edge-cases.md')).toBe(out1!.replace('1-run.md', '2-edge-cases.md'))
  expect(second).toContain(out1!)
  await expect(panes(page)).toHaveCount(3)
  await page.getByTestId('e2e-queue-button').click()
  await expect(row.getByTestId('e2e-job-status')).toHaveText('실행 중 2/3 ② 엣지케이스 찾기')

  // AC-06: [다음 단계]로 ② 를 먼저 넘긴다 → ③
  await dialog.getByRole('button', { name: named('다음 단계') }).click()
  await expect(row.getByTestId('e2e-job-status')).toHaveText('실행 중 3/3 ③ 엣지케이스 기반 테스트')
  await expect.poll(() => writes(page), { timeout: 10_000 }).toHaveLength(3)
  expect(resultOf((await writes(page))[2], '3-verify.md')).toBeTruthy()

  // AC-09: [패널로 이동] → 대화상자를 닫고 ③ 의 패널을 고른다
  await dialog.getByRole('button', { name: named('패널로 이동') }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('[data-testid="terminal-pane"]:visible.outline-ring')).toContainText('3-verify.md')

  // ③ 도 넘기면 완료 — 남은 작업이 없다
  await page.getByTestId('e2e-queue-button').click()
  await dialog.getByRole('button', { name: named('다음 단계') }).click()
  await expect(row.getByTestId('e2e-job-status')).toHaveText('완료')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('e2e-queue-button')).toHaveAccessibleName('E2E 큐')
  // 끝난 단계의 패널은 남는다(D-7)
  await expect(panes(page)).toHaveCount(4)
})

test('EC-22·AC-07·AC-08 ssh 인증을 묻는 동안 [취소]하면 인증 뒤에도 명령을 넣지 않는다 — [다시 실행]은 새 패널에서 다시, [목록에서 지우기]', async ({ page }) => {
  test.setTimeout(60_000)
  await openIssue42(page)
  // 큐가 여는 터미널이 ssh 비밀번호를 묻는 것처럼
  await page.evaluate(() => (window.__MINMO_MOCK__!.nextPtyBanner = "dev@mock-server's password: "))
  await page.getByRole('button', { name: 'E2E 큐에 추가' }).click()
  await expect(panes(page)).toHaveCount(2, { timeout: 10_000 })
  await expect(panes(page).nth(1)).toContainText('password:')
  // 묻는 동안에는 넣지 않는다
  await page.waitForTimeout(1000)
  expect(await writes(page)).toEqual([])

  await page.getByTestId('e2e-queue-button').click()
  const dialog = page.getByRole('dialog', { name: 'E2E 큐' })
  const row = dialog.getByTestId('e2e-job')
  await dialog.getByRole('button', { name: named('취소') }).click()
  await expect(row.getByTestId('e2e-job-status')).toHaveText('취소')
  // 대화상자가 열려 있는 동안 바깥은 보조 기술에서 가려진다 — 이름(aria-label)만 본다
  await expect(page.getByTestId('e2e-queue-button')).toHaveAttribute('aria-label', 'E2E 큐')

  // 인증이 끝나 셸이 떠도 취소한 명령은 들어가지 않는다
  await emit(page, 2, '\r\nWelcome\r\n$ ')
  await expect(panes(page).nth(1)).toContainText('Welcome')
  await page.waitForTimeout(1500)
  expect(await writes(page)).toEqual([])

  // AC-08: [다시 실행] → 새 대기 작업이 시작되어 새 패널(세 번째 터미널)에만 명령이 들어간다
  await dialog.getByRole('button', { name: named('다시 실행') }).click()
  await expect(row).toHaveCount(2)
  await expect(row.nth(1).getByTestId('e2e-job-status')).toHaveText('실행 중 1/3 ① E2E 실행', { timeout: 10_000 })
  await expect.poll(() => writes(page), { timeout: 10_000 }).toHaveLength(1)
  expect(resultOf((await writes(page))[0], '1-run.md')).toBeTruthy()
  await expect(panes(page)).toHaveCount(3)

  // AC-07: 실행 중 작업 취소 → 패널은 남긴다. 끝난 작업은 목록에서 지운다
  await dialog.getByRole('button', { name: named('취소') }).click()
  await expect(row.nth(1).getByTestId('e2e-job-status')).toHaveText('취소')
  await expect(panes(page)).toHaveCount(3)
  await dialog.getByRole('button', { name: named('목록에서 지우기') }).first().click()
  await dialog.getByRole('button', { name: named('목록에서 지우기') }).click()
  await expect(row).toHaveCount(0)
  await expect(dialog).toContainText('큐가 비어 있습니다')
})

test('EC-23 실행 중 단계의 에이전트가 입력을 기다리면 상단 버튼과 작업 행에 "확인 필요"를 보이고, 다시 일하면 지운다', async ({ page }) => {
  test.setTimeout(60_000)
  await openIssue42(page)
  await page.getByRole('button', { name: 'E2E 큐에 추가' }).click()
  await expect.poll(() => writes(page), { timeout: 10_000 }).toHaveLength(1)

  // 다른 이슈(기타)를 보는 동안은 #42 의 패널을 보고 있지 않다 — 그때 울린 벨은 입력 대기다
  await page.getByTestId('issue-row-etc').click()
  await expect(page.getByTestId('issue-header')).toContainText('기타')
  await page.evaluate(() => window.__MINMO_MOCK__!.setPtyProcesses(2, ['claude.exe']))
  await emit(page, 2, title('✳ E2E 실행'))
  await emit(page, 2, '\x07')
  const button = page.getByTestId('e2e-queue-button')
  await expect(button).toHaveAccessibleName('E2E 큐 (1) — 확인 필요', { timeout: 10_000 })
  await expect(button).toContainText('확인 필요')
  await button.click()
  const dialog = page.getByRole('dialog', { name: 'E2E 큐' })
  await expect(dialog.getByTestId('e2e-job-notice')).toHaveText('확인 필요 — 패널을 보세요')
  await page.keyboard.press('Escape')

  // 에이전트가 다시 일하면 지운다
  await emit(page, 2, title('◐ E2E 실행'))
  await expect(button).toHaveAccessibleName('E2E 큐 (1)', { timeout: 10_000 })
  await button.click()
  await expect(dialog.getByTestId('e2e-job-notice')).toHaveCount(0)
  await dialog.getByRole('button', { name: named('취소') }).click()
})

test('AC-10·AC-11·EC-05·EC-06 역할 설정: CLI·모델(목록·직접 입력)·지시문을 저장하고 다시 켜도 그대로 — 목록을 못 받으면 직접 입력', async ({ page }) => {
  await page.evaluate((raw) => {
    window.__MINMO_MOCK__!.setAgentModels('claude', raw)
    window.__MINMO_MOCK__!.setAgentModels('codex', new Error('codex 를 찾지 못했습니다'))
  }, CLAUDE_CATALOG)
  await page.getByTestId('e2e-queue-button').click()
  const dialog = page.getByRole('dialog', { name: 'E2E 큐' })
  // A-10: 이슈를 하나도 열지 않았으면 단계가 시작되지 않는다고 알린다
  await expect(dialog.getByTestId('e2e-no-issue')).toBeVisible()
  await dialog.getByRole('tab', { name: '역할 설정' }).click()
  await expect(dialog.getByTestId('e2e-models-source')).toHaveText('목록 출처: 이 PC')

  const run = dialog.getByRole('group', { name: '① E2E 실행' })
  await expect(run.getByLabel('모델', { exact: true }).locator('option')).toHaveText(['기본값(CLI 설정)', 'Opus 4.1 (claude-opus-4-1)', 'Sonnet 4.5 (claude-sonnet-4-5)', '직접 입력…'])
  await run.getByLabel('모델', { exact: true }).selectOption('claude-sonnet-4-5')

  const edge = dialog.getByRole('group', { name: '② 엣지케이스 찾기' })
  await edge.getByRole('radio', { name: 'Codex' }).click()
  await expect(edge.getByRole('status')).toHaveText('모델 목록을 불러오지 못했습니다: codex 를 찾지 못했습니다 — 모델 이름을 직접 입력할 수 있습니다')
  await edge.getByLabel('모델', { exact: true }).selectOption({ label: '직접 입력…' })
  const name = edge.getByLabel('모델 이름')
  await name.fill('gpt 5; rm -rf')
  await expect(name).toHaveAttribute('aria-invalid', 'true')
  await expect(name).toHaveAccessibleDescription(/저장하지 않았습니다/)
  await name.fill('gpt-5.1-codex')
  await expect(name).not.toHaveAttribute('aria-invalid')

  const verify = dialog.getByRole('group', { name: '③ 엣지케이스 기반 테스트' })
  await verify.getByLabel('지시문').fill('{issue} 의 엣지케이스 테스트를 돌리고 {out} 에 쓴다')
  await expect(verify.getByRole('button', { name: '기본값' })).toBeVisible()

  // 다시 켜도 그대로(minmo-ui 저장) — mock 도 새로 만들어지므로 모델 목록을 다시 정한다
  await page.reload()
  await page.evaluate((raw) => window.__MINMO_MOCK__!.setAgentModels('claude', raw), CLAUDE_CATALOG)
  await page.getByTestId('e2e-queue-button').click()
  await dialog.getByRole('tab', { name: '역할 설정' }).click()
  await expect(run.getByLabel('모델', { exact: true })).toHaveValue('claude-sonnet-4-5')
  await expect(edge.getByRole('radio', { name: 'Codex' })).toBeChecked()
  await expect(edge.getByLabel('모델 이름')).toHaveValue('gpt-5.1-codex')
  await expect(verify.getByLabel('지시문')).toHaveValue('{issue} 의 엣지케이스 테스트를 돌리고 {out} 에 쓴다')
  // [기본값] 으로 지시문을 되돌린다
  await verify.getByRole('button', { name: '기본값' }).click()
  await expect(verify.getByRole('button', { name: '기본값' })).toHaveCount(0)
})

test('EC-15 원격 호스트 이슈는 첫 패널(남아 있던 세션)을 쓰지 않고 새 패널에서 실행한다 — 명령은 POSIX 따옴표', async ({ page }) => {
  await page.getByRole('button', { name: '원격 호스트 관리' }).click()
  await page.getByTestId('ssh-host-mock-server').getByRole('button', { name: '추가' }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('combobox', { name: '작업 호스트' }).selectOption('mock-server')
  await expandWidgets(page)
  await page.getByTestId('issue-row-42').click()
  await expect(page.getByTestId('issue-branch')).toHaveText('feat/42')

  // 터미널을 열지 않은 채 큐에 넣는다 → 첫 패널 + 큐의 새 패널
  await page.getByRole('button', { name: 'E2E 큐에 추가' }).click()
  await expect(panes(page)).toHaveCount(2, { timeout: 10_000 })
  await expect.poll(() => writes(page), { timeout: 10_000 }).toHaveLength(1)
  expect((await writes(page))[0]).toMatch(/^claude '이슈 #42 Add login .*\.minmo\/e2e\/[A-Za-z0-9-]+\/1-run\.md/)
  await expect(panes(page).nth(1)).toContainText("claude '")
  await expect(panes(page).nth(0)).toContainText('mock-server:')
  await expect(panes(page).nth(0)).not.toContainText("claude '")

  await page.getByTestId('e2e-queue-button').click()
  await page.getByRole('dialog', { name: 'E2E 큐' }).getByRole('button', { name: named('취소') }).click()
})
