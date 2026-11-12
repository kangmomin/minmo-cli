// 새 프로젝트(로컬 폴더) → 작업 → 작업 폴더 → GitHub 에 올리기, 폴더 열기, GitHub 저장소 추가 (mock git·GitHub)
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { GITHUB, json, login, routeGitHub, routeServer } from './fixtures'

test.beforeEach(async ({ page }) => {
  await routeServer(page)
  await routeGitHub(page)
  await login(page)
})

async function addMenu(page: Page, item: string) {
  await page.getByRole('button', { name: '저장소 추가' }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

async function newProject(page: Page, name: string) {
  await addMenu(page, '새 프로젝트…')
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('프로젝트 이름(폴더 이름)').fill(name)
  await dialog.getByLabel('만들 위치(상위 폴더)').fill('~/src')
  await dialog.getByRole('button', { name: '만들기' }).click()
  await expect(dialog).toBeHidden()
}

const localRepo = (page: Page) => page.locator('[data-testid^="repo-node-_local/"]')

test('새 프로젝트 → 로컬 저장소로 보이고, 작업을 추가해 열면 작업 폴더가 생긴다(PR·push 버튼 없음)', async ({ page }) => {
  await newProject(page, 'my-app')
  await expect(page.getByTestId('org-node-_local')).toContainText('로컬 저장소')
  await expect(localRepo(page)).toContainText('my-app')
  const git = await page.evaluate(() => window.__MINMO_MOCK__!.gitCalls)
  expect(git).toContainEqual(['init', '-b', 'main', '/home/minmo/src/my-app'])
  expect(git).toContainEqual(['-C', '/home/minmo/src/my-app', 'commit', '--allow-empty', '-m', 'Initial commit'])

  // 만들자마자 펼쳐져 있다: 기타 + 작업 추가
  await expect(page.getByTestId('issue-row-etc')).toBeVisible()
  await page.getByTestId('add-task').click()
  await page.getByRole('dialog').getByLabel('제목').fill('로그인 화면')
  await page.getByRole('dialog').getByRole('button', { name: '추가' }).click()
  await expect(page.getByTestId('issue-row-1')).toContainText('로그인 화면')

  await page.getByTestId('issue-row-1').click()
  await expect(page.getByTestId('issue-branch')).toHaveText('feat/1')
  // 저장소 이름 자리에는 내부 id(_local/…)가 아니라 폴더명이 보인다
  await expect(page.getByTestId('issue-header').locator('span').first()).toHaveText('my-app')
  await expect(page.getByTestId('issue-row-1').getByLabel('worktree 있음')).toBeVisible()
  // origin 이 없는 저장소: fetch 하지 않고 로컬 브랜치에서 만든다
  const after = await page.evaluate(() => window.__MINMO_MOCK__!.gitCalls)
  expect(after.some((a) => a.includes('fetch') || a.includes('clone'))).toBe(false)
  expect(after.find((a) => a.includes('worktree') && a.includes('add'))?.at(-1)).toBe('refs/heads/main')

  await page.getByRole('tab', { name: '변경' }).click()
  await expect(page.getByTestId('changes-tab')).toBeVisible()
  await expect(page.getByTestId('changes-tab').getByRole('button', { name: 'PR' })).toHaveCount(0)
  await expect(page.getByTestId('changes-tab').getByRole('button', { name: 'push' })).toHaveCount(0)

  // 작업 닫기: 작업 폴더가 있으면 닫힘 배지와 함께 남는다
  await page.getByTestId('issue-row-1').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '작업 닫기' }).click()
  await expect(page.getByTestId('issue-row-1')).toContainText('닫힘')

  // 새로고침해도 목록이 남는다(이 PC 에 저장)
  await page.reload()
  await expect(localRepo(page)).toContainText('my-app')
})

test('GitHub 에 올리기 → 저장소·이슈를 만들고 GitHub 저장소로 전환된다', async ({ page }) => {
  // 올린 뒤에만 보이는 저장소와 그 이슈
  let created = false
  const issues: { number: number; title: string; state: string; html_url: string }[] = []
  const posted: { path: string; body: unknown }[] = []
  await page.route(`${GITHUB}/**`, async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const repo = { name: 'my-app', owner: { login: 'octocat' }, default_branch: 'main' }
    if (req.method() === 'OPTIONS') return route.fallback()
    if (req.method() !== 'GET') posted.push({ path, body: JSON.parse(req.postData() ?? 'null') })
    if (path === '/user/repos' && req.method() === 'POST') {
      created = true
      return json(route, 201, repo)
    }
    if (path === '/user/repos' && created) return json(route, 200, [repo])
    if (path === '/repos/octocat/my-app') return created ? json(route, 200, repo) : json(route, 404, { message: 'Not Found' })
    if (path === '/repos/octocat/my-app/issues' && req.method() === 'POST') {
      const title = (JSON.parse(req.postData() ?? '{}') as { title: string }).title
      const issue = { number: issues.length + 1, title, state: 'open', html_url: '' }
      issues.push(issue)
      return json(route, 201, issue)
    }
    if (path === '/repos/octocat/my-app/issues') return json(route, 200, issues)
    const m = /^\/repos\/octocat\/my-app\/issues\/(\d+)$/.exec(path)
    if (m && req.method() === 'PATCH') {
      issues[Number(m[1]) - 1].state = 'closed'
      return json(route, 200, issues[Number(m[1]) - 1])
    }
    return route.fallback()
  })

  await newProject(page, 'my-app')
  for (const title of ['첫 작업', '닫을 작업']) {
    await page.getByTestId('add-task').click()
    await page.getByRole('dialog').getByLabel('제목').fill(title)
    await page.getByRole('dialog').getByRole('button', { name: '추가' }).click()
  }
  await page.getByTestId('issue-row-1').click()
  await expect(page.getByTestId('issue-branch')).toHaveText('feat/1')
  await page.getByTestId('issue-row-2').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '작업 닫기' }).click()

  await localRepo(page).hover()
  await page.getByRole('button', { name: 'my-app 저장소 메뉴' }).click()
  await page.getByRole('menuitem', { name: 'GitHub 에 올리기…' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('저장소 이름')).toHaveValue('my-app')
  await expect(dialog.getByLabel('비공개 저장소')).toBeChecked()
  await expect(dialog).toContainText('작업 2개가 GitHub 이슈로 만들어집니다')
  await dialog.getByRole('button', { name: '올리기' }).click()
  await expect(dialog).toContainText('octocat/my-app 로 올렸습니다')
  await dialog.getByRole('button', { name: '확인' }).click()

  expect(posted.map((p) => p.path)).toEqual(['/user/repos', '/repos/octocat/my-app/issues', '/repos/octocat/my-app/issues', '/repos/octocat/my-app/issues/2'])
  expect(posted[0].body).toEqual({ name: 'my-app', private: true, auto_init: false })
  const git = await page.evaluate(() => window.__MINMO_MOCK__!.gitCalls)
  expect(git).toContainEqual(['-C', '/home/minmo/src/my-app', 'remote', 'add', 'origin', 'https://github.com/octocat/my-app.git'])
  expect(git).toContainEqual(['-C', '/home/minmo/src/my-app', 'push', '-u', 'origin', '--all'])

  // 로컬 항목은 사라지고 내 계정 아래의 GitHub 저장소로 — 작업 폴더(●)와 기준 저장소 표시가 이어진다
  await expect(localRepo(page)).toHaveCount(0)
  const repo = page.getByTestId('repo-node-octocat/my-app')
  await expect(repo).toBeVisible()
  await expect(repo.getByTestId('base-repo-badge')).toBeVisible()
  await expect(page.getByTestId('issue-row-1')).toContainText('첫 작업')
  await expect(page.getByTestId('issue-row-1').getByLabel('worktree 있음')).toBeVisible()
  // 닫은 작업은 닫힌 이슈가 되어(작업 폴더 없음) 숨는다
  await expect(page.getByTestId('issue-row-2')).toHaveCount(0)
})

test('폴더 열기: 폴더 선택 창으로 고른 저장소를 로컬 저장소로 연다 · git 저장소가 아니면 거부', async ({ page }) => {
  // 열 폴더를 먼저 만든다(mock git 에 저장소로 등록)
  await newProject(page, 'existing')
  await localRepo(page).hover()
  await page.getByRole('button', { name: 'existing 저장소 메뉴' }).click()
  await page.getByRole('menuitem', { name: '목록에서 제거' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '제거' }).click()
  await expect(localRepo(page)).toHaveCount(0)

  await addMenu(page, '폴더 열기…')
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('저장소 폴더').fill('/home/minmo/nope')
  await dialog.getByRole('button', { name: '열기' }).click()
  await expect(dialog.getByRole('alert')).toContainText('git 저장소(작업 폴더)가 아닙니다')

  await page.evaluate(() => {
    window.__MINMO_MOCK__!.pickedFolder = '/home/minmo/src/existing'
  })
  await dialog.getByRole('button', { name: '찾아보기' }).click()
  await expect(dialog.getByLabel('저장소 폴더')).toHaveValue('/home/minmo/src/existing')
  await dialog.getByRole('button', { name: '열기' }).click()
  await expect(dialog).toBeHidden()
  await expect(localRepo(page)).toContainText('existing')
})

test('GitHub 저장소 추가: 목록에 없는 소유자의 저장소가 새 소유자 노드로 보인다', async ({ page }) => {
  await page.route(`${GITHUB}/repos/other/lib`, (route) => json(route, 200, { name: 'Lib', owner: { login: 'Other' }, default_branch: 'main' }))
  await page.route(`${GITHUB}/repos/Other/Lib/issues**`, (route) => json(route, 200, [{ number: 3, title: 'Upstream bug', state: 'open', html_url: '' }]))
  await addMenu(page, 'GitHub 저장소 추가…')
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('저장소').fill('other/nope')
  await dialog.getByRole('button', { name: '추가' }).click()
  await expect(dialog.getByRole('alert')).toContainText('찾을 수 없거나 볼 권한이 없습니다')
  await dialog.getByLabel('저장소').fill('other/lib')
  await dialog.getByRole('button', { name: '추가' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('org-node-Other')).toBeVisible()
  await expect(page.getByTestId('repo-node-Other/Lib')).toBeVisible()
  await expect(page.getByTestId('issue-row-3')).toContainText('Upstream bug')

  // 목록에서 제거하면 소유자 노드도 사라진다
  await page.getByTestId('repo-node-Other/Lib').hover()
  await page.getByRole('button', { name: 'Lib 저장소 메뉴' }).click()
  await page.getByRole('menuitem', { name: '목록에서 제거' }).click()
  await expect(page.getByTestId('org-node-Other')).toHaveCount(0)
})
