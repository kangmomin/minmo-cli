// PC 사이 동기화 — 무엇을 어느 쪽에 보낼지(나중에 고친 쪽·충돌 사본), 저장소 목록·에이전트 명령 합치기, 한 번 맞추는 흐름
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncDoc, SyncNote, SyncSetting } from '@minmo/api-client'

import type { RemoteConnection } from '../../lib/tauri.remote'
import { useReposStore } from '../../store/repos'
import { useUiStore } from '../../store/ui'
import { DEFAULT_AGENT_COMMANDS } from '../agents/launch'
import { conflictHeader, mergeCommands, planSync, syncWithPeer, unionRepos } from './peerSync'

const NAMES = { mine: '집 PC', theirs: '회사 PC' }
const note = (key: string, body: string, updatedAtMs: number): SyncNote => ({ owner: 'acme', repo: 'app', key, body, updatedAtMs })
const setting = (owner: string, branchTemplate: string | null, updatedAtMs: number): SyncSetting => ({
  scope: 'org',
  owner,
  repo: '',
  branchTemplate,
  etcBranchName: null,
  worktreePath: null,
  mainClonePath: null,
  postCreateScript: null,
  sparsePaths: null,
  postCreateScriptPosix: null,
  updatedAtMs,
})
const doc = (notes: SyncNote[] = [], settings: SyncSetting[] = []): SyncDoc => ({ notes, settings })

beforeEach(() => {
  localStorage.clear()
  useReposStore.setState({ added: [], local: {} })
  useUiStore.setState({ agentCommands: DEFAULT_AGENT_COMMANDS })
})

describe('planSync: 어느 쪽에 무엇을 보낼지', () => {
  it('한쪽에만 있는 것은 다른 쪽으로 보낸다 · 같은 것은 보내지 않는다', () => {
    const p = planSync(doc([note('1', 'mine only', 10), note('3', 'same', 5)], [setting('a', 'x/{number}', 10)]), doc([note('2', 'theirs only', 20), note('3', 'same', 99)], [setting('b', 'y/{number}', 10)]), 0, NAMES)
    expect(p.toTheirs.notes.map((n) => n.key)).toEqual(['1'])
    expect(p.toMine.notes.map((n) => n.key)).toEqual(['2'])
    expect(p.toTheirs.settings.map((s) => s.owner)).toEqual(['a'])
    expect(p.toMine.settings.map((s) => s.owner)).toEqual(['b'])
    expect(p.conflicts).toBe(0)
  })

  it('같은 항목이 다르면 나중에 고친 쪽을 쓴다', () => {
    // 지난 동기화(100) 뒤에 한쪽만 고쳤다 → 그쪽 값을 다른 쪽에 넣는다(충돌 사본 없음)
    const p = planSync(doc([note('1', 'old', 50), note('2', 'mine new', 300)], [setting('a', 'old/{number}', 50)]), doc([note('1', 'theirs new', 200), note('2', 'old2', 60)], [setting('a', 'new/{number}', 200)]), 100, NAMES)
    expect(p.toMine.notes).toEqual([note('1', 'theirs new', 200)])
    expect(p.toTheirs.notes).toEqual([note('2', 'mine new', 300)])
    expect(p.toMine.settings[0].branchTemplate).toBe('new/{number}')
    expect(p.conflicts).toBe(0)
  })

  it('양쪽에서 고친 메모는 나중 것을 쓰되, 밀린 쪽 내용을 충돌 사본으로 붙여 양쪽에 둔다', () => {
    const p = planSync(doc([note('1', '내가 쓴 것', 200)]), doc([note('1', '회사에서 쓴 것', 300)]), 100, NAMES)
    const merged = `회사에서 쓴 것${conflictHeader('집 PC', 200)}내가 쓴 것`
    expect(p.toMine.notes).toEqual([note('1', merged, 301)])
    expect(p.toTheirs.notes).toEqual([note('1', merged, 301)])
    expect(p.conflicts).toBe(1)
    // 다음에 다시 맞추면 양쪽이 같으므로 아무것도 하지 않는다
    expect(planSync(doc(p.toMine.notes), doc(p.toTheirs.notes), 400, NAMES)).toEqual({ toMine: doc(), toTheirs: doc(), conflicts: 0 })
  })

  it('처음 맞출 때(지난 동기화 없음) 서로 다른 메모는 둘 다 남긴다 · 이미 들어 있는 내용은 다시 붙이지 않는다', () => {
    expect(planSync(doc([note('1', 'A', 10)]), doc([note('1', 'B', 20)]), 0, NAMES).conflicts).toBe(1)
    // 이긴 쪽이 밀린 쪽 내용을 이미 담고 있으면(앞서 붙인 사본 등) 그대로 쓴다
    const p = planSync(doc([note('1', 'A', 10)]), doc([note('1', 'B\n\nA', 20)]), 0, NAMES)
    expect(p).toMatchObject({ conflicts: 0, toMine: { notes: [note('1', 'B\n\nA', 20)] } })
    // 밀린 쪽이 빈 메모면 붙일 것이 없다
    expect(planSync(doc([note('1', '  ', 10)]), doc([note('1', 'B', 20)]), 0, NAMES).conflicts).toBe(0)
  })

  it('같은 시각에 다르게 고쳤어도 두 PC 가 같은 결론을 낸다', () => {
    const a = planSync(doc([note('1', 'apple', 10)]), doc([note('1', 'banana', 10)]), 50, NAMES)
    const b = planSync(doc([note('1', 'banana', 10)]), doc([note('1', 'apple', 10)]), 50, NAMES)
    expect(a.toMine.notes[0].body).toBe('banana')
    expect(b.toTheirs.notes[0].body).toBe('banana')
  })

  it('합친 메모가 크기 상한(1MiB)을 넘으면 충돌 사본을 붙이지 않고 나중 것만 쓴다', () => {
    const big = 'x'.repeat(700_000)
    const p = planSync(doc([note('1', big + 'a', 200)]), doc([note('1', big + 'b', 300)]), 100, NAMES)
    expect(p.conflicts).toBe(0)
    expect(p.toMine.notes[0].body).toBe(big + 'b')
    expect(p.toTheirs.notes).toEqual([])
  })
})

describe('저장소 목록 · 에이전트 실행 명령', () => {
  it('저장소 목록은 더하기만 맞춘다(대소문자 무시)', () => {
    expect(unionRepos(['acme/app', 'me/x'], ['Acme/App', 'org/y'])).toEqual({ all: ['Acme/App', 'org/y', 'me/x'], addMine: ['org/y'] })
    expect(unionRepos([], [])).toEqual({ all: [], addMine: [] })
  })

  it('한쪽만 고친 명령은 양쪽에 쓰고, 둘 다 다르게 고쳤으면 각자 둔다', () => {
    const mine = { ...DEFAULT_AGENT_COMMANDS, claude: 'claude --mine {prompt}', codex: 'codex --a {prompt}' }
    const theirs = { ...DEFAULT_AGENT_COMMANDS, gemini: 'gemini --theirs -i {prompt}', codex: 'codex --b {prompt}' }
    const m = mergeCommands(mine, theirs)
    expect(m.mine).toEqual({ ...mine, gemini: 'gemini --theirs -i {prompt}' })
    expect(m.theirs).toEqual({ ...theirs, claude: 'claude --mine {prompt}' })
  })
})

describe('syncWithPeer: 한 번 맞추기', () => {
  /** 그 PC 흉내 — 서버의 설정·메모와 함께 쓰는 상태 */
  function peer(server: SyncDoc, shared: Record<string, Record<string, unknown>> = {}) {
    const revs: Record<string, number> = {}
    const imported: SyncDoc[] = []
    const call = vi.fn(async (method: string, args: unknown[]) => {
      if (method === 'syncExport') return server
      if (method === 'syncImport') return void imported.push(args[0] as SyncDoc)
      if (method === 'sharedGet') return { value: shared[args[0] as string] ? JSON.stringify(shared[args[0] as string]) : null, rev: revs[args[0] as string] ?? 0 }
      if (method === 'sharedSet') {
        const [key, value, , base] = args as [string, string, string, number]
        if (base !== (revs[key] ?? 0)) throw new Error('shared_conflict')
        shared[key] = JSON.parse(value) as Record<string, unknown>
        revs[key] = base + 1
        return revs[key]
      }
      throw new Error('unexpected ' + method)
    })
    return { conn: { call } as unknown as RemoteConnection, imported, shared, call }
  }

  it('설정·메모는 필요한 쪽에만 보내고, 저장소 목록과 에이전트 명령을 합친다', async () => {
    useReposStore.setState({ added: ['me/mine'] })
    useUiStore.getState().setAgentCommand('claude', 'claude --mine {prompt}')
    const p = peer(doc([note('2', 'theirs', 20)]), { repos: { added: ['org/theirs'], local: { keep: 1 } }, ui: { agentCommands: { codex: 'codex --theirs {prompt}' }, panes: { keep: 1 } } })
    const api = { syncExport: vi.fn(async () => doc([note('1', 'mine', 10)])), syncImport: vi.fn(async () => ({ settings: 0, notes: 1, skipped: 0 })) }
    const queryClient = { invalidateQueries: vi.fn(async () => {}) }
    const r = await syncWithPeer({ id: 'p1', name: '회사 PC' }, p.conn, { api, queryClient, now: () => 1000 })

    expect(api.syncImport).toHaveBeenCalledWith(doc([note('2', 'theirs', 20)]))
    expect(queryClient.invalidateQueries).toHaveBeenCalled()
    expect(p.imported).toEqual([doc([note('1', 'mine', 10)])])
    // 저장소 목록: 양쪽에 서로의 것이 더해진다. 그 PC 의 다른 값(로컬 저장소 등)은 건드리지 않는다
    expect(useReposStore.getState().added).toEqual(['me/mine', 'org/theirs'])
    expect(p.shared.repos).toEqual({ added: ['org/theirs', 'me/mine'], local: { keep: 1 } })
    // 에이전트 명령: 각자 고친 것이 서로에게 간다
    expect(useUiStore.getState().agentCommands).toMatchObject({ claude: 'claude --mine {prompt}', codex: 'codex --theirs {prompt}' })
    expect(p.shared.ui).toMatchObject({ agentCommands: { claude: 'claude --mine {prompt}', codex: 'codex --theirs {prompt}' }, panes: { keep: 1 } })
    expect(r.conflicts).toBe(0)
    expect(r.moved).toBeGreaterThanOrEqual(4)
    // 맞춘 시각을 기억한다(다음 충돌 판정의 기준)
    expect(JSON.parse(localStorage.getItem('minmo-peer-sync')!)).toEqual({ p1: 1000 })
  })

  it('이미 같으면 아무것도 보내지 않는다', async () => {
    const same = doc([note('1', 'x', 10)])
    const p = peer(same, { repos: { added: [] }, ui: { agentCommands: DEFAULT_AGENT_COMMANDS } })
    const api = { syncExport: vi.fn(async () => same), syncImport: vi.fn(async () => ({ settings: 0, notes: 0, skipped: 0 })) }
    const r = await syncWithPeer({ id: 'p1', name: 'x' }, p.conn, { api })
    expect(r).toEqual({ moved: 0, conflicts: 0 })
    expect(api.syncImport).not.toHaveBeenCalled()
    expect(p.call.mock.calls.map((c) => c[0])).toEqual(['syncExport', 'sharedGet', 'sharedGet'])
  })

  it('그 PC 가 동기화를 처리하지 못하면(옛 버전 등) 실패로 끝나고 맞춘 시각을 남기지 않는다', async () => {
    const conn = { call: vi.fn(async () => Promise.reject(new Error('원격에서 쓸 수 없는 기능입니다: syncExport'))) } as unknown as RemoteConnection
    const api = { syncExport: vi.fn(async () => doc()), syncImport: vi.fn() }
    await expect(syncWithPeer({ id: 'p1', name: 'x' }, conn, { api })).rejects.toThrow('syncExport')
    expect(localStorage.getItem('minmo-peer-sync')).toBeNull()
  })
})
