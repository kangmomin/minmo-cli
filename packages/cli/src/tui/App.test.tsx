import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'

import { worktreeId } from '@minmo/core'

import { createTestCtx } from '../test/fakes'
import { App } from './App'
import type { ExitResult } from './App'
import { buildRows, expandSelection } from './model'

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const DOWN = '\u001B[B'
const ENTER = '\r'
const ESC = '\u001B'

async function waitFor(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout')
    await tick(20)
  }
}

describe('TUI 트리 모델', () => {
  const data = {
    owners: [{ login: 'Acme', kind: 'org' as const, avatarUrl: null }],
    repos: { Acme: [{ owner: 'Acme', name: 'Widgets', defaultBranch: 'main' }, { owner: 'Acme', name: 'gadgets', defaultBranch: 'main' }] },
    issues: { 'Acme/Widgets': [{ key: 'etc', number: null, title: '★기타', state: 'open' as const }, { key: '3', number: 3, title: 'Old', state: 'closed' as const }] },
  }

  it('선택에 따라 거르고, 숨겼어도 worktree 가 있으면 hidden 으로 남긴다, closed 는 worktree 있을 때만', () => {
    const expanded = new Set(['o:Acme', 'r:Acme/Widgets'])
    const worktrees = { [worktreeId('Acme', 'gadgets', '1')]: { path: '/w', branch: 'b' } }
    const rows = buildRows(data, { sel: ['acme/widgets'], showAll: false, expanded, search: '', worktrees })
    expect(rows.map((r) => r.id)).toEqual(['o:Acme', 'r:Acme/Widgets', 'i:Acme/Widgets#etc', 'r:Acme/gadgets'])
    expect(rows.find((r) => r.id === 'r:Acme/gadgets')).toMatchObject({ hidden: true, worktrees: 1 })
  })

  it('expandSelection: 전체 표시(null)·조직 전체를 명시 목록으로 펼친다(하나만 숨길 때 나머지 유지)', () => {
    expect(expandSelection(null, ['Acme', 'zed'], 'Acme', ['Widgets', 'gadgets'])).toEqual(['zed/*', 'acme/widgets', 'acme/gadgets'])
    expect(expandSelection(['acme/widgets'], ['Acme'], 'Acme', ['Widgets', 'gadgets'])).toEqual(['acme/widgets'])
  })

  it('검색은 저장소 이름으로 거르고 조직을 자동으로 펼친다', () => {
    const rows = buildRows(data, { sel: null, showAll: false, expanded: new Set(), search: 'gad', worktrees: {} })
    expect(rows.map((r) => r.id)).toEqual(['o:Acme', 'r:Acme/gadgets'])
  })
})

describe('TUI', () => {
  it('전체 표시 중 f 로 저장소 하나를 숨기면 나머지는 그대로 보인다', async () => {
    const ctx = await createTestCtx()
    const ui = render(<App ctx={ctx} login="octocat" onExit={() => {}} rows={30} />)
    await waitFor(() => ui.lastFrame()!.includes('▸ Acme'))
    ui.stdin.write(DOWN)
    await tick()
    ui.stdin.write(ENTER)
    await waitFor(() => ui.lastFrame()!.includes('gadgets'))
    ui.stdin.write(DOWN)
    await tick()
    ui.stdin.write('f') // Widgets 숨김
    await waitFor(() => ui.lastFrame()!.includes('보일 저장소를 저장했습니다'))
    expect(ctx.api.putVisibleRepos).toHaveBeenCalledWith({ repos: ['acme/gadgets', 'octocat/*'], baseUpdatedAt: null })
    ui.unmount()
  })

  it('조직을 펼치고 저장소·이슈를 고른 뒤 Enter 로 worktree 를 준비한다', async () => {
    const ctx = await createTestCtx()
    ctx.worktree.openIssue = vi.fn(async (t) => {
      ctx.state.worktrees[worktreeId(t.owner, t.repo, t.key)] = { path: '/ws/Acme/Widgets/issue--7', branch: 'issue/7-seven' }
      return { issueId: 'x', path: '/ws/Acme/Widgets/issue--7', branch: 'issue/7-seven', created: true, pathChanged: false, script: { status: 'skipped' as const, exitCode: null } }
    })
    const onExit = vi.fn()
    const ui = render(<App ctx={ctx} login="octocat" onExit={onExit} rows={30} />)
    await waitFor(() => ui.lastFrame()!.includes('▸ Acme'))
    // octocat ▸, Acme ▸ → Acme 로 내려가 펼침
    ui.stdin.write(DOWN)
    await tick()
    ui.stdin.write(ENTER)
    await waitFor(() => ui.lastFrame()!.includes('Widgets'))
    ui.stdin.write(DOWN)
    await tick()
    ui.stdin.write(ENTER)
    await waitFor(() => ui.lastFrame()!.includes('#7 Seven'))
    expect(ui.lastFrame()).not.toContain('#3 Old') // closed + worktree 없음
    ui.stdin.write(DOWN)
    await tick()
    ui.stdin.write(DOWN)
    await tick()
    expect(ui.lastFrame()).toContain('worktree 없음')
    ui.stdin.write(ENTER)
    await waitFor(() => ui.lastFrame()!.includes('준비됨'))
    expect(ctx.worktree.openIssue).toHaveBeenCalledWith({ owner: 'Acme', repo: 'Widgets', key: '7', number: 7, title: 'Seven' })
    expect(ui.lastFrame()).toContain('브랜치 issue/7-seven')
    ui.unmount()
  })

  it('t 는 터미널로 넘기고(onExit attach, 상태 보존), q 는 종료', async () => {
    const ctx = await createTestCtx()
    ctx.state.worktrees[worktreeId('octocat', 'dotfiles', 'etc')] = { path: '/ws/octocat/dotfiles/etc', branch: 'etc' }
    let result: ExitResult | null = null
    const ui = render(<App ctx={ctx} login="octocat" onExit={(r) => (result = r)} rows={30} />)
    // 헤더에도 로그인 이름이 있으므로 트리 행을 기다린다
    await waitFor(() => ui.lastFrame()!.includes('▸ octocat'))
    ui.stdin.write(ENTER) // octocat 펼침
    await waitFor(() => ui.lastFrame()!.includes('dotfiles'))
    ui.stdin.write(DOWN)
    await tick()
    ui.stdin.write(ENTER)
    await waitFor(() => ui.lastFrame()!.includes('★기타'))
    ui.stdin.write(DOWN)
    await tick()
    ui.stdin.write('t')
    await waitFor(() => result !== null)
    expect(result).toMatchObject({ kind: 'attach', path: '/ws/octocat/dotfiles/etc', title: 'dotfiles#etc' })
    expect((result as unknown as { snapshot: { cursorId: string } }).snapshot.cursorId).toBe('i:octocat/dotfiles#etc')
  })

  it('로컬 모드: 헤더에 표시, f 는 이 기기 로컬에 저장, n(메모)은 서버 모드 안내', async () => {
    const ctx = await createTestCtx({ mode: 'local', loggedIn: false })
    const onExit = vi.fn()
    const ui = render(<App ctx={ctx} login={null} onExit={onExit} rows={30} />)
    await waitFor(() => ui.lastFrame()!.includes('▸ Acme'))
    expect(ui.lastFrame()).toContain('로컬 모드(서버 없이)')
    ui.stdin.write(DOWN)
    await tick()
    ui.stdin.write('f') // Acme 조직 전체 숨김(전체 표시 → 명시 목록)
    await waitFor(() => ui.lastFrame()!.includes('이 기기 로컬'))
    expect(ctx.config.local.visibleRepos).toEqual(['octocat/*'])
    expect(ctx.api.putVisibleRepos).not.toHaveBeenCalled()
    ui.stdin.write('a') // 숨긴 것도 보기
    await waitFor(() => ui.lastFrame()!.includes('숨긴 것 포함'))
    ui.stdin.write(ENTER) // Acme 펼침(커서는 Acme 에 남아 있다)
    await waitFor(() => ui.lastFrame()!.includes('Widgets'))
    ui.stdin.write(DOWN)
    await tick()
    ui.stdin.write(ENTER)
    await waitFor(() => ui.lastFrame()!.includes('#7 Seven'))
    ui.stdin.write(DOWN)
    await tick()
    ui.stdin.write('n')
    await waitFor(() => ui.lastFrame()!.includes('메모는 서버 모드에서만'))
    expect(onExit).not.toHaveBeenCalled()
    ui.unmount()
  })

  it('i 로 이슈 등록: 제목 → 본문 → 목록에만 추가(커서 그대로), Esc 는 취소', async () => {
    const ctx = await createTestCtx({ github: { createIssue: async (_o, _r, title) => ({ number: 9, title, state: 'open', htmlUrl: 'u9' }) } })
    const ui = render(<App ctx={ctx} login="octocat" onExit={() => {}} rows={30} />)
    await waitFor(() => ui.lastFrame()!.includes('▸ Acme'))
    ui.stdin.write(DOWN)
    await tick()
    ui.stdin.write(ENTER) // Acme 펼침
    await waitFor(() => ui.lastFrame()!.includes('Widgets'))
    ui.stdin.write(DOWN)
    await tick()
    ui.stdin.write(ENTER) // Widgets 펼침
    await waitFor(() => ui.lastFrame()!.includes('#7 Seven'))

    ui.stdin.write('i')
    await waitFor(() => ui.lastFrame()!.includes('이슈 등록 Acme/Widgets · 제목:'))
    ui.stdin.write(ESC)
    await waitFor(() => ui.lastFrame()!.includes('취소했습니다'))

    ui.stdin.write('i')
    await waitFor(() => ui.lastFrame()!.includes('제목:'))
    ui.stdin.write(ENTER) // 빈 제목은 넘어가지 않는다
    await waitFor(() => ui.lastFrame()!.includes('제목을 입력하세요'))
    ui.stdin.write('quick fix') // 입력 중에는 단축키(q 종료)가 글자다
    await waitFor(() => ui.lastFrame()!.includes('제목: quick fix'))
    ui.stdin.write(ENTER)
    await waitFor(() => ui.lastFrame()!.includes('본문(선택, 한 줄):'))
    ui.stdin.write('details')
    await waitFor(() => ui.lastFrame()!.includes('details'))
    ui.stdin.write(ENTER)
    await waitFor(() => ui.lastFrame()!.includes('등록했습니다: Acme/Widgets#9'))
    expect(ctx.github.createIssue).toHaveBeenCalledWith('Acme', 'Widgets', 'quick fix', 'details')
    const frame = ui.lastFrame()!
    expect(frame.indexOf('#9 quick fix')).toBeGreaterThan(frame.indexOf('★기타'))
    expect(frame.indexOf('#9 quick fix')).toBeLessThan(frame.indexOf('#7 Seven'))
    expect(ctx.github.listIssues).toHaveBeenCalledTimes(1)
    // 커서는 저장소 줄 그대로 — 상세 칸이 저장소 정보다
    expect(frame).toContain('기본 브랜치 main')
    ui.unmount()
  })

  it('이슈 등록 실패: 오류를 보여 주고 입력한 내용으로 되돌아간다', async () => {
    const ctx = await createTestCtx({
      github: {
        createIssue: async () => {
          throw new Error('Issues are disabled')
        },
      },
    })
    const ui = render(<App ctx={ctx} login="octocat" onExit={() => {}} rows={30} />)
    await waitFor(() => ui.lastFrame()!.includes('▸ Acme'))
    ui.stdin.write(DOWN)
    await tick()
    ui.stdin.write(ENTER)
    await waitFor(() => ui.lastFrame()!.includes('Widgets'))
    ui.stdin.write(DOWN)
    await tick()
    ui.stdin.write('i')
    await waitFor(() => ui.lastFrame()!.includes('제목:'))
    ui.stdin.write('title')
    await waitFor(() => ui.lastFrame()!.includes('제목: title'))
    ui.stdin.write(ENTER)
    await waitFor(() => ui.lastFrame()!.includes('본문(선택, 한 줄):'))
    ui.stdin.write(ENTER)
    await waitFor(() => ui.lastFrame()!.includes('이슈를 등록하지 못했습니다: Issues are disabled'))
    expect(ui.lastFrame()).toContain('본문(선택, 한 줄):')
    ui.unmount()
  })

  it('a 로 숨긴 저장소를 보고 f 로 보일 저장소에 추가한다(서버 저장)', async () => {
    const ctx = await createTestCtx({ api: { getVisibleRepos: async () => ({ repos: ['acme/widgets'], updatedAt: 't1' }) } })
    const ui = render(<App ctx={ctx} login="octocat" onExit={() => {}} rows={30} />)
    await waitFor(() => ui.lastFrame()!.includes('▸ Acme'))
    expect(ui.lastFrame()).not.toContain('▸ octocat')
    ui.stdin.write(ENTER) // Acme 펼침
    await waitFor(() => ui.lastFrame()!.includes('Widgets'))
    expect(ui.lastFrame()).not.toContain('gadgets')
    ui.stdin.write('a')
    await waitFor(() => ui.lastFrame()!.includes('gadgets (숨김)'))
    // octocat, Acme, (dotfiles 는 octocat 접힘) Widgets, gadgets 순 — gadgets 로 이동
    for (let i = 0; i < 3; i++) {
      ui.stdin.write(DOWN)
      await tick()
    }
    ui.stdin.write('f')
    await waitFor(() => ui.lastFrame()!.includes('보일 저장소를 저장했습니다'))
    expect(ctx.api.putVisibleRepos).toHaveBeenCalledWith({ repos: ['acme/gadgets', 'acme/widgets'], baseUpdatedAt: 't1' })
    ui.unmount()
  })
})
