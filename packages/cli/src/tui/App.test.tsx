import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'

import { worktreeId } from '@minmo/core'

import { createTestCtx } from '../test/fakes'
import { App } from './App'
import type { ExitResult } from './App'
import { buildRows } from './model'

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const DOWN = '\u001B[B'
const ENTER = '\r'

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

  it('검색은 저장소 이름으로 거르고 조직을 자동으로 펼친다', () => {
    const rows = buildRows(data, { sel: null, showAll: false, expanded: new Set(), search: 'gad', worktrees: {} })
    expect(rows.map((r) => r.id)).toEqual(['o:Acme', 'r:Acme/gadgets'])
  })
})

describe('TUI', () => {
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

  it('t 는 tmux 로 넘기고(onExit attach, 상태 보존), q 는 종료', async () => {
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
