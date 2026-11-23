// 페어링 동기화 — 받기·올리기·변경 없음·409 재시도·토큰/URL 없음
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PairSyncError } from '@minmo/api-client'
import type { PairPayload, PairState, SyncDoc, SyncNote } from '@minmo/api-client'

import { usePairStore } from '../../store/pairSync'
import { useReposStore } from '../../store/repos'
import { pairSyncOnce, runPairSync, usePairSyncStatus } from './pairSync'

const note = (key: string, body: string, updatedAtMs: number): SyncNote => ({ owner: 'acme', repo: 'app', key, body, updatedAtMs })
const doc = (notes: SyncNote[] = []): SyncDoc => ({ settings: [], notes })

function setup(remote: { rev: number; payload: Partial<PairPayload> }, mine: SyncDoc) {
  let state: PairState = { ...remote, updatedAt: 1 }
  const client = {
    create: vi.fn(),
    join: vi.fn(),
    reissueCode: vi.fn(),
    get: vi.fn(async () => state),
    put: vi.fn(async (_id: string, _t: string, baseRev: number, payload: PairPayload) => {
      state = { rev: baseRev + 1, payload, updatedAt: 2 }
      return state
    }),
  }
  const api = { syncExport: vi.fn(async () => mine), syncImport: vi.fn(async (d: SyncDoc) => ((mine = { ...mine, notes: [...mine.notes, ...d.notes] }), { settings: 0, notes: d.notes.length, skipped: 0 })) }
  const deps = { client, api, pairId: 'p1', token: 't', myName: '집 PC' }
  return { client, api, deps, get state() { return state } }
}

beforeEach(() => {
  localStorage.clear()
  useReposStore.setState({ added: [], local: {} })
  usePairStore.setState({ url: '', pairId: null })
  usePairSyncStatus.setState({ s: { busy: false, at: null, error: null, moved: 0 } })
})

describe('pairSyncOnce', () => {
  it('서버 사본에만 있는 메모는 이 PC 로 받고, 이 PC 에만 있는 것은 서버로 올린다', async () => {
    const t = setup({ rev: 3, payload: { doc: doc([note('2', 'from other', 20)]), repos: ['a/b'] } }, doc([note('1', 'mine', 10)]))
    const r = await pairSyncOnce(t.deps)
    expect(t.api.syncImport).toHaveBeenCalledWith(expect.objectContaining({ notes: [note('2', 'from other', 20)] }))
    expect(useReposStore.getState().added).toContain('a/b')
    expect(t.client.put).toHaveBeenCalledWith('p1', 't', 3, expect.objectContaining({ repos: ['a/b'] }))
    expect(t.state.payload.doc?.notes.map((n) => n.key).sort()).toEqual(['1', '2'])
    expect(r.moved).toBeGreaterThan(0)
  })

  it('깨진 서버 사본(모양이 다른 값)에도 멈추지 않고 이 PC 내용으로 덮어쓴다', async () => {
    const t = setup({ rev: 5, payload: { doc: { notes: 'x' } as unknown as SyncDoc, repos: [1, 'noslash', 'a/b'] as unknown as string[] } }, doc([note('1', 'mine', 10)]))
    await pairSyncOnce(t.deps)
    expect(useReposStore.getState().added).toEqual(['a/b'])
    expect(t.client.put).toHaveBeenCalledWith('p1', 't', 5, expect.objectContaining({ repos: ['a/b'] }))
  })

  it('같은 내용이면 올리지 않는다', async () => {
    const t = setup({ rev: 1, payload: { doc: doc([note('1', 'same', 10)]), repos: [] } }, doc([note('1', 'same', 10)]))
    await pairSyncOnce(t.deps)
    expect(t.client.put).not.toHaveBeenCalled()
    expect(t.api.syncImport).not.toHaveBeenCalled()
  })

  it('올리는 사이 다른 PC 가 먼저 올렸으면(409) 다시 읽어 맞춘다', async () => {
    const t = setup({ rev: 1, payload: { doc: doc(), repos: [] } }, doc([note('1', 'mine', 10)]))
    t.client.put.mockRejectedValueOnce(new PairSyncError(409, 'conflict', { rev: 2, payload: {}, updatedAt: 3 }))
    await pairSyncOnce(t.deps)
    expect(t.client.get).toHaveBeenCalledTimes(2)
    expect(t.client.put).toHaveBeenCalledTimes(2)
  })

  it('409 가 계속되면 실패로 알린다', async () => {
    const t = setup({ rev: 1, payload: { doc: doc(), repos: [] } }, doc([note('1', 'mine', 10)]))
    t.client.put.mockRejectedValue(new PairSyncError(409, 'conflict'))
    await expect(pairSyncOnce(t.deps)).rejects.toThrow('맞추지 못했습니다')
  })

  it('서버 오류(409 아님)는 그대로 던진다', async () => {
    const t = setup({ rev: 1, payload: {} }, doc([note('1', 'mine', 10)]))
    t.client.put.mockRejectedValue(new PairSyncError(401, 'unauthorized'))
    await expect(pairSyncOnce(t.deps)).rejects.toMatchObject({ status: 401 })
  })

  it('올리는 내용에 실행되는 값이 섞이지 않는다 — doc 은 settings·notes·nowMs, repos 만', async () => {
    const t = setup({ rev: 0, payload: {} }, doc([note('1', 'mine', 10)]))
    await pairSyncOnce(t.deps)
    const sent = t.client.put.mock.calls[0][3]
    expect(Object.keys(sent).sort()).toEqual(['doc', 'repos'])
    expect(JSON.stringify(sent)).not.toMatch(/postCreateScript|worktreePath|mainClonePath/)
  })
})

describe('runPairSync', () => {
  const tauri = { keychainGet: vi.fn(), deviceName: vi.fn(async () => '집 PC') }
  const api = { syncExport: vi.fn(), syncImport: vi.fn() }

  it('연결되지 않았으면 아무것도 하지 않는다', async () => {
    await runPairSync({ tauri, api })
    expect(tauri.keychainGet).not.toHaveBeenCalled()
  })

  it('키체인에 토큰이 없으면 오류를 상태에 남긴다', async () => {
    usePairStore.setState({ url: 'http://x', pairId: 'p1' })
    tauri.keychainGet.mockResolvedValue(null)
    await runPairSync({ tauri, api })
    expect(usePairSyncStatus.getState().s.error).toContain('연결 정보가 없습니다')
    expect(usePairSyncStatus.getState().s.busy).toBe(false)
  })
})
