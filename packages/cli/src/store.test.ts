import { readFile, writeFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { tempPaths } from './test/fakes'
import { loadConfig, loadState, reloadState, saveCredentials, statePathStore, updateConfig, updateState } from './store'

describe('로컬 상태 저장', () => {
  it('다른 프로세스가 그 사이 쓴 worktree 를 덮어쓰지 않는다(파일을 다시 읽어 내 변경만 얹는다)', async () => {
    const p = await tempPaths()
    const mine = await loadState(p)
    // 다른 minmo 프로세스(예: tmux 패널의 `minmo open`)가 먼저 저장
    await writeFile(p.state, JSON.stringify({ worktrees: { 'o/r#1': { path: '/w/1', branch: 'b1' } }, effective: {} }))
    await updateState(p, mine, (s) => {
      s.worktrees['o/r#2'] = { path: '/w/2', branch: 'b2' }
    })
    const disk = JSON.parse(await readFile(p.state, 'utf8'))
    expect(Object.keys(disk.worktrees).sort()).toEqual(['o/r#1', 'o/r#2'])
    // 메모리는 reload 로 파일과 맞춘다
    await reloadState(p, mine)
    expect(Object.keys(mine.worktrees).sort()).toEqual(['o/r#1', 'o/r#2'])
  })

  it('경로 저장소: 겹친 쓰기도 순서대로 반영되고 삭제가 유지된다', async () => {
    const p = await tempPaths()
    const state = await loadState(p)
    const store = statePathStore(p, state)
    store.set('a#1', { path: '/a', branch: 'a' })
    store.set('b#1', { path: '/b', branch: 'b' })
    store.delete('a#1')
    await updateState(p, state, () => {})
    expect(Object.keys(JSON.parse(await readFile(p.state, 'utf8')).worktrees)).toEqual(['b#1'])
  })

  it('config.json: 없으면 서버 모드·빈 로컬 값, 다른 프로세스가 쓴 로컬 값을 덮어쓰지 않는다', async () => {
    const p = await tempPaths()
    const mine = await loadConfig(p)
    expect(mine).toEqual({ mode: 'server', local: { global: {}, orgs: {}, projects: {} } })
    // 다른 minmo(예: tmux 패널의 `minmo config set`)가 먼저 저장 — 이상한 mode 값은 server 로 읽는다
    await writeFile(p.config, JSON.stringify({ mode: 'ssh', local: { global: { etcBranchName: 'misc' }, visibleRepos: null } }))
    await updateConfig(p, mine, (c) => {
      c.local.projects['o/r'] = { sparsePaths: 'a' }
    })
    const disk = await loadConfig(p)
    expect(disk).toEqual({ mode: 'server', local: { global: { etcBranchName: 'misc' }, orgs: {}, projects: { 'o/r': { sparsePaths: 'a' } }, visibleRepos: null } })
    // TUI 복귀 때 로컬 값도 다시 읽는다
    const state = await loadState(p)
    await reloadState(p, state, mine)
    expect(mine.local.visibleRepos).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('자격 증명은 0600', async () => {
    const p = await tempPaths()
    await saveCredentials(p, { session: 's', login: 'l', savedAt: 't' })
    const { stat } = await import('node:fs/promises')
    expect((await stat(p.credentials)).mode & 0o777).toBe(0o600)
  })
})
