// PC 사이 동기화 — 무엇을 어느 쪽에 보낼지(나중에 고친 쪽·충돌 사본·기본값·시계 차이), 저장소 목록 합치기, 한 번 맞추는 흐름
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncDoc, SyncNote, SyncSetting } from '@minmo/api-client'

import type { RemoteConnection } from '../../lib/tauri.remote'
import { useReposStore } from '../../store/repos'
import { DEFAULT_GLOBAL, conflictHeader, planSync, shiftDoc, syncWithPeer, unionRepos } from './peerSync'

const NAMES = { mine: '집 PC', theirs: '회사 PC' }
const note = (key: string, body: string, updatedAtMs: number): SyncNote => ({ owner: 'acme', repo: 'app', key, body, updatedAtMs })
const org = (owner: string, branchTemplate: string | null, updatedAtMs: number): SyncSetting => ({ scope: 'org', owner, repo: '', branchTemplate, etcBranchName: null, sparsePaths: null, updatedAtMs })
const global = (branchTemplate: string, updatedAtMs: number): SyncSetting => ({ scope: 'global', owner: '', repo: '', ...DEFAULT_GLOBAL, branchTemplate, updatedAtMs })
const doc = (notes: SyncNote[] = [], settings: SyncSetting[] = [], nowMs?: number): SyncDoc => ({ notes, settings, ...(nowMs === undefined ? {} : { nowMs }) })

beforeEach(() => {
  localStorage.clear()
  useReposStore.setState({ added: [], local: {} })
})

describe('planSync: 어느 쪽에 무엇을 보낼지', () => {
  it('한쪽에만 있는 것은 다른 쪽으로 보낸다 · 같은 것은 보내지 않는다', () => {
    const p = planSync(doc([note('1', 'mine only', 10), note('3', 'same', 5)], [org('a', 'x/{number}', 10)]), doc([note('2', 'theirs only', 20), note('3', 'same', 99)], [org('b', 'y/{number}', 10)]), 0, NAMES)
    expect(p.toTheirs.notes.map((n) => n.key)).toEqual(['1'])
    expect(p.toMine.notes.map((n) => n.key)).toEqual(['2'])
    expect(p.toTheirs.settings.map((s) => s.owner)).toEqual(['a'])
    expect(p.toMine.settings.map((s) => s.owner)).toEqual(['b'])
    expect(p.conflicts).toBe(0)
  })

  it('같은 항목이 다르면 나중에 고친 쪽을 쓴다 — 보내는 것에는 밀린 쪽보다 뒤의 시각을 붙인다', () => {
    // 지난 동기화(100) 뒤에 한쪽만 고쳤다 → 그쪽 값을 다른 쪽에 넣는다(충돌 사본 없음)
    const p = planSync(doc([note('1', 'old', 50), note('2', 'mine new', 300)], [org('a', 'old/{number}', 50)]), doc([note('1', 'theirs new', 200), note('2', 'old2', 60)], [org('a', 'new/{number}', 200)]), 100, NAMES)
    expect(p.toMine.notes).toEqual([note('1', 'theirs new', 200)])
    expect(p.toTheirs.notes).toEqual([note('2', 'mine new', 300)])
    expect(p.toMine.settings[0]).toMatchObject({ branchTemplate: 'new/{number}', updatedAtMs: 200 })
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
    const p = planSync(doc([note('1', 'A', 10)]), doc([note('1', 'B\n\nA', 20)]), 0, NAMES)
    expect(p).toMatchObject({ conflicts: 0, toMine: { notes: [note('1', 'B\n\nA', 20)] } })
    expect(planSync(doc([note('1', '  ', 10)]), doc([note('1', 'B', 20)]), 0, NAMES).conflicts).toBe(0)
  })

  it('같은 시각에 다르게 고쳤어도 두 PC 가 같은 결론을 내고, 받는 쪽 서버가 받아들이게 더 뒤의 시각으로 보낸다', () => {
    const a = planSync(doc([note('1', 'apple', 10)]), doc([note('1', 'banana', 10)]), 50, NAMES)
    const b = planSync(doc([note('1', 'banana', 10)]), doc([note('1', 'apple', 10)]), 50, NAMES)
    // 서버는 "더 새로운 것"만 넣는다 — 같은 시각(10)으로 보내면 영영 안 들어간다
    expect(a.toMine.notes).toEqual([note('1', 'banana', 11)])
    expect(b.toTheirs.notes).toEqual([note('1', 'banana', 11)])
    const s = planSync(doc([], [org('a', 'x/{number}', 10)]), doc([], [org('a', 'y/{number}', 10)]), 50, NAMES)
    expect(s.toMine.settings).toEqual([org('a', 'y/{number}', 11)])
  })

  it('손대지 않은 전역 기본값은 고친 값을 이기지 못한다(새로 설치한 PC 가 다듬어 둔 설정을 덮지 않는다)', () => {
    // 이 PC 는 오래전에 고쳤고(100), 그 PC 는 방금 설치해 기본값이 더 새롭다(9000)
    const p = planSync(doc([], [global('feat/{number}', 100)]), doc([], [global(DEFAULT_GLOBAL.branchTemplate, 9000)]), 0, NAMES)
    expect(p.toMine.settings).toEqual([])
    expect(p.toTheirs.settings).toEqual([global('feat/{number}', 9001)])
    // 둘 다 고친 값이면 나중에 고친 쪽
    expect(planSync(doc([], [global('a/{number}', 100)]), doc([], [global('b/{number}', 200)]), 0, NAMES).toMine.settings[0].branchTemplate).toBe('b/{number}')
    // 전역 설정이 없는 쪽에 만들어 주지는 않는다(로그인할 때 생긴다)
    expect(planSync(doc([], [global('a/{number}', 100)]), doc(), 0, NAMES)).toMatchObject({ toMine: doc(), toTheirs: doc() })
  })

  it('합친 메모가 크기 상한(1MiB)을 넘으면 충돌 사본을 붙이지 않고 나중 것만 쓴다', () => {
    const big = 'x'.repeat(700_000)
    const p = planSync(doc([note('1', big + 'a', 200)]), doc([note('1', big + 'b', 300)]), 100, NAMES)
    expect(p.conflicts).toBe(0)
    expect(p.toMine.notes[0].body).toBe(big + 'b')
    expect(p.toTheirs.notes).toEqual([])
  })
})

describe('저장소 목록', () => {
  it('더하기만 맞춘다(대소문자 무시)', () => {
    expect(unionRepos(['acme/app', 'me/x'], ['Acme/App', 'org/y'])).toEqual({ all: ['Acme/App', 'org/y', 'me/x'], addMine: ['org/y'] })
    expect(unionRepos([], [])).toEqual({ all: [], addMine: [] })
  })
})

describe('syncWithPeer: 한 번 맞추기', () => {
  /** 그 PC 흉내 — 서버의 설정·메모와 함께 쓰는 상태 */
  function peer(server: SyncDoc, shared: Record<string, Record<string, unknown>> = {}, opts: { skipped?: number; conflictOnSet?: boolean; failOnSet?: boolean } = {}) {
    const revs: Record<string, number> = {}
    const imported: SyncDoc[] = []
    const call = vi.fn(async (method: string, args: unknown[]) => {
      if (method === 'syncExport') return server
      if (method === 'syncImport') {
        imported.push(args[0] as SyncDoc)
        return { settings: 0, notes: 0, skipped: opts.skipped ?? 0 }
      }
      if (method === 'sharedGet') return { value: shared[args[0] as string] ? JSON.stringify(shared[args[0] as string]) : null, rev: revs[args[0] as string] ?? 0 }
      if (method === 'sharedSet') {
        if (opts.failOnSet) throw new Error('disk full')
        const [key, value, , base] = args as [string, string, string, number]
        if (opts.conflictOnSet || base !== (revs[key] ?? 0)) throw new Error('shared_conflict')
        shared[key] = JSON.parse(value) as Record<string, unknown>
        revs[key] = base + 1
        return revs[key]
      }
      throw new Error('unexpected ' + method)
    })
    return { conn: { call } as unknown as RemoteConnection, imported, shared, call }
  }
  const myApi = (mine: SyncDoc, skipped = 0) => ({ syncExport: vi.fn(async () => mine), syncImport: vi.fn(async (_doc: SyncDoc) => ({ settings: 0, notes: 0, skipped })) })
  const P = { id: 'p1', name: '회사 PC' }

  it('메모는 필요한 쪽에만 보내고, 저장소 목록을 서로 더한다(그 PC 의 다른 값은 건드리지 않는다)', async () => {
    useReposStore.setState({ added: ['me/mine'] })
    const p = peer(doc([note('2', 'theirs', 20)], [], 5000), { repos: { added: ['org/theirs', 'not a repo'], local: { keep: 1 } } })
    const api = myApi(doc([note('1', 'mine', 10)], [], 5000))
    const queryClient = { invalidateQueries: vi.fn(async () => {}) }
    const r = await syncWithPeer(P, p.conn, { api, queryClient, myName: '집 PC' })
    expect(api.syncImport).toHaveBeenCalledWith(doc([note('2', 'theirs', 20)]))
    expect(queryClient.invalidateQueries).toHaveBeenCalled()
    expect(p.imported).toEqual([doc([note('1', 'mine', 10)])])
    expect(useReposStore.getState().added).toEqual(['me/mine', 'org/theirs'])
    expect(p.shared.repos).toEqual({ added: ['org/theirs', 'me/mine'], local: { keep: 1 } })
    expect(r).toEqual({ moved: 4, conflicts: 0 })
    // 맞춘 시각은 이 PC 서버의 시계로 기억한다
    expect(JSON.parse(localStorage.getItem('minmo-peer-sync')!)).toEqual({ p1: 5000 })
  })

  it('두 PC 의 시계가 달라도 실제로 나중에 고친 쪽이 이긴다 — 그 PC 의 시각을 이 PC 의 시계로 옮겨 견주고, 보낼 때는 그 PC 의 시계로 되돌린다', async () => {
    // 그 PC 의 시계는 1시간 느리다. 그 PC 에서 "방금"(그 PC 시계 100_000) 고친 메모가, 이 PC 에서 10분 전(3_100_000)에 고친 것보다 새롭다
    const HOUR = 3_600_000
    const p = peer(doc([note('1', '방금 그 PC 에서', 100_000), note('2', '옛 것', 10_000)], [], 200_000))
    const api = myApi(doc([note('1', '10분 전 이 PC 에서', 3_100_000), note('2', '이 PC 에서 새로', 3_700_000)], [], 200_000 + HOUR))
    localStorage.setItem('minmo-peer-sync', JSON.stringify({ p1: 3_650_000 }))
    await syncWithPeer(P, p.conn, { api, myName: '집 PC' })
    // 이 PC 로: 그 PC 의 메모(이 PC 시계로 3_700_000)가 이긴다 — 이 PC 의 것은 지난 동기화 전에 고친 것이라 충돌 사본 없음
    expect(api.syncImport.mock.calls[0][0].notes).toEqual([note('1', '방금 그 PC 에서', 100_000 + HOUR)])
    // 그 PC 로: 그 PC 의 시계로 되돌린 시각(터무니없이 앞선 시각이 되지 않는다)
    expect(p.imported[0].notes).toEqual([note('2', '이 PC 에서 새로', 3_700_000 - HOUR)])
  })

  it('서버가 일부를 넣지 않았으면(그 사이에 고쳐졌다) 맞춘 시각을 앞당기지 않는다 — 다음에 충돌 사본을 남길 수 있게', async () => {
    localStorage.setItem('minmo-peer-sync', JSON.stringify({ p1: 111 }))
    const p = peer(doc([note('1', 'theirs', 300)], [], 5000), {}, { skipped: 0 })
    await syncWithPeer(P, p.conn, { api: myApi(doc([note('1', 'mine', 200)], [], 5000), 1) })
    expect(JSON.parse(localStorage.getItem('minmo-peer-sync')!)).toEqual({ p1: 111 })
    const q = peer(doc([note('9', 'x', 1)], [], 5000), {}, { skipped: 1 })
    await syncWithPeer(P, q.conn, { api: myApi(doc([note('8', 'y', 1)], [], 5000)) })
    expect(JSON.parse(localStorage.getItem('minmo-peer-sync')!)).toEqual({ p1: 111 })
  })

  it('이미 같으면 아무것도 보내지 않는다', async () => {
    const same = doc([note('1', 'x', 10)], [], 5000)
    const p = peer(same, { repos: { added: [] } })
    const api = myApi(same)
    expect(await syncWithPeer(P, p.conn, { api })).toEqual({ moved: 0, conflicts: 0 })
    expect(api.syncImport).not.toHaveBeenCalled()
    expect(p.call.mock.calls.map((c) => c[0])).toEqual(['syncExport', 'sharedGet'])
  })

  it('저장소 목록을 올리다 그 PC 의 화면과 겹치면 넘어가고(센 것에 넣지 않는다), 그 밖의 실패는 알린다', async () => {
    useReposStore.setState({ added: ['me/mine'] })
    const busy = peer(doc([], [], 1), { repos: { added: [] } }, { conflictOnSet: true })
    expect(await syncWithPeer(P, busy.conn, { api: myApi(doc([], [], 1)) })).toEqual({ moved: 0, conflicts: 0 })
    const broken = peer(doc([], [], 1), { repos: { added: [] } }, { failOnSet: true })
    await expect(syncWithPeer(P, broken.conn, { api: myApi(doc([], [], 1)) })).rejects.toThrow('disk full')
  })

  it('그 PC 가 동기화를 처리하지 못하면(옛 버전 등) 실패로 끝나고 맞춘 시각을 남기지 않는다', async () => {
    const conn = { call: vi.fn(async () => Promise.reject(new Error('원격에서 쓸 수 없는 기능입니다: syncExport'))) } as unknown as RemoteConnection
    await expect(syncWithPeer(P, conn, { api: myApi(doc()) })).rejects.toThrow('syncExport')
    expect(localStorage.getItem('minmo-peer-sync')).toBeNull()
  })

  it('shiftDoc: 수정 시각을 다른 PC 의 시계로 옮긴다', () => {
    expect(shiftDoc(doc([note('1', 'x', 100)], [org('a', 'x/{number}', 200)]), -50)).toEqual(doc([note('1', 'x', 50)], [org('a', 'x/{number}', 150)]))
  })
})
