// F-06 메모 (AC-12, EC-07/CT-15) — 1초 디바운스 PUT, 409 모달
import { expect, test } from '@playwright/test'

import { expandWidgets, login, routeGitHub, routeServer } from './fixtures'

async function openNotes(page: import('@playwright/test').Page) {
  await expandWidgets(page)
  await page.getByTestId('issue-row-42').click()
  await page.getByRole('tab', { name: '메모' }).click()
  return page.getByRole('textbox', { name: '메모' })
}

test('입력 후 1초 → PUT(baseUpdatedAt:null) → 저장됨', async ({ page }) => {
  const { calls } = await routeServer(page)
  await routeGitHub(page)
  await login(page)
  const editor = await openNotes(page)
  await editor.fill('first note')
  await expect(page.getByTestId('notes-status')).toHaveAttribute('data-state', 'saved', { timeout: 5000 })
  const put = calls.find((c) => c.method === 'PUT' && c.path === '/projects/my-org/widgets/issues/42/notes')
  expect(put?.body).toEqual({ body: 'first note', baseUpdatedAt: null })
})

test('409 → "다른 기기에서 수정됨" 모달 → [서버 내용 불러오기]', async ({ page }) => {
  await routeServer(page, (req, path) =>
    req.method() === 'PUT' && path.endsWith('/notes')
      ? { status: 409, body: { error: 'conflict', body: 'server body', updatedAt: '2026-11-09T12:00:09.000Z' } }
      : undefined,
  )
  await routeGitHub(page)
  await login(page)
  const editor = await openNotes(page)
  await editor.fill('mine')
  await expect(page.getByText('다른 기기에서 수정됨')).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: '서버 내용 불러오기' }).click()
  await expect(page.getByRole('textbox', { name: '메모' })).toHaveValue('server body')
})

test('서버 미연결 → OfflineBanner + 메모 편집 비활성', async ({ page }) => {
  let down = false
  await routeServer(page, (_req, path) => (down && path !== '/healthz' ? { status: 502, body: { error: 'github_unavailable' } } : undefined))
  await routeGitHub(page)
  await login(page)
  const editor = await openNotes(page)
  await expect(editor).toBeEnabled()
  down = true
  await editor.fill('offline edit')
  await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 5000 })
  await expect(page.getByRole('textbox', { name: '메모' })).toBeDisabled()
})
