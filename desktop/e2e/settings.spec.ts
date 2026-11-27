// F-07 설정 (AC-13·AC-15, CT-09·CT-22·CT-28) — 트리 컨텍스트 메뉴 → 설정 다이얼로그
import { expect, test } from '@playwright/test'

import { expandWidgets, login, openSettings, routeGitHub, routeServer } from './fixtures'

test('프로젝트 설정: 상속 placeholder, 브랜치 템플릿 feat/{number} 저장 → 나머지 null, 미리보기 feat/42', async ({ page }) => {
  const { calls } = await routeServer(page)
  await routeGitHub(page)
  await login(page)
  await expandWidgets(page)

  await page.getByTestId('repo-node-my-org/widgets').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '프로젝트 설정' }).click()

  const dialog = page.getByRole('dialog', { name: '설정', exact: true })
  const branch = dialog.getByLabel('브랜치 템플릿')
  await expect(branch).toHaveAttribute('placeholder', '상속: issue/{number}-{slug}')
  await expect(dialog.getByRole('radiogroup', { name: '생성 후 스크립트', exact: true }).getByRole('radio', { name: '상속' })).toBeChecked()

  await branch.fill('feat/{number}')
  await expect(dialog.getByTestId('preview-branch')).toHaveText('feat/42')
  // EC-30: 프로젝트 범위 폼은 화면보다 높다 — 오른쪽 내용 칸만 스크롤되어 휠로 [저장] 까지 닿는다(클릭의 자동 스크롤보다 먼저 확인)
  await page.setViewportSize({ width: 1280, height: 600 })
  const save = dialog.getByRole('button', { name: '저장' })
  await expect(save).not.toBeInViewport()
  await dialog.getByRole('tabpanel').hover()
  await page.mouse.wheel(0, 3000)
  await expect(save).toBeInViewport()
  await save.click()
  await expect(dialog.getByText('저장했습니다', { exact: true })).toBeVisible()

  const put = calls.find((c) => c.method === 'PUT' && c.path === '/projects/my-org/widgets/settings')
  expect(put?.body).toEqual({ branchTemplate: 'feat/{number}', etcBranchName: null, worktreePath: null, mainClonePath: null, postCreateScript: null, sparsePaths: null, postCreateScriptPosix: null, ignoredCopyExclude: null })
})

test('조직 설정: 400 field 오류는 인라인(aria-invalid), 저장 버튼 유지', async ({ page }) => {
  await routeServer(page, (req, path) =>
    req.method() === 'PUT' && path === '/orgs/my-org/settings' ? { status: 400, body: { error: 'invalid_template', field: 'etcBranchName' } } : undefined,
  )
  await routeGitHub(page)
  await login(page)
  await page.getByTestId('org-node-my-org').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '조직 설정' }).click()
  const dialog = page.getByRole('dialog', { name: '설정', exact: true })
  await dialog.getByLabel('기타 브랜치명').fill('a b')
  await dialog.getByRole('button', { name: '저장' }).click()
  await expect(dialog.getByLabel('기타 브랜치명')).toHaveAttribute('aria-invalid', 'true')
  await expect(dialog.getByRole('button', { name: '저장' })).toBeEnabled()
})

test('전역 설정(⚙): 상속 선택지 없음, 기본값 표시', async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  await login(page)
  const dialog = await openSettings(page, '작업 공간')
  await expect(dialog.getByLabel('worktree 경로')).toHaveValue('~/minmo-workspaces/{owner}/{repo}/{branch}')
  await expect(dialog.getByRole('radio', { name: '상속' })).toHaveCount(0)
  // 스크립트 그룹이 Windows·Linux/macOS 두 개라 각각 확인한다
  for (const name of ['생성 후 스크립트', '생성 후 스크립트 (Linux/macOS)']) {
    await expect(dialog.getByRole('radiogroup', { name, exact: true }).getByRole('radio', { name: '없음' })).toBeChecked()
  }
})

test('AC-02·AC-04·AC-16 ⚙ → 설정 화면(검색·분류 탭), "포트" 로 거르면 원격 호스트·원격 접속·서버·앱만 남고, Esc 로 닫으면 ⚙ 로 포커스가 돌아온다', async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  await login(page)
  const dialog = await openSettings(page)
  const search = dialog.getByRole('searchbox', { name: '설정 검색', exact: true })
  await expect(search).toBeVisible()
  const tabs = dialog.getByRole('tablist', { name: '설정 분류', exact: true }).getByRole('tab')
  // mock 런타임(native 아님) — 동기화 분류는 없다
  await expect(tabs).toHaveText(['모양', '알림·표시', '에이전트', '작업 공간', '원격 호스트', '원격 접속', '원격 CLI', '서버·앱'])

  await search.fill('포트')
  await expect(tabs).toHaveText(['원격 호스트', '원격 접속', '서버·앱'])

  // 검색창에 포커스가 있어도 Esc 는 설정 전체를 닫는다
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: '설정', exact: true })).toBeFocused()
})
