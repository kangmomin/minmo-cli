// 설정 페어링 동기화 — 페어 서버에 놓인 "함께 쓰는 사본"과 이 PC 를 맞춘다.
// 메모·설정(이름을 정하는 값)·저장소 목록만 오간다. 실행되는 값(생성 후 스크립트·작업 폴더 경로·에이전트 명령)과
// 로그인 정보는 PC 간 동기화(peerSync)와 같은 이유로 싣지 않는다. 맞추는 규칙은 peerSync.planSync 를 그대로 쓴다.
import { useEffect } from 'react'
import { create } from 'zustand'

import { PairSyncError, createPairSyncClient } from '@minmo/api-client'
import type { ApiClient, PairPayload, PairSyncClient, SyncDoc } from '@minmo/api-client'

import { KEYCHAIN_KEYS } from '../../lib/tauri'
import type { TauriApi } from '../../lib/tauri'
import { usePairStore } from '../../store/pairSync'
import { splitFullName, useReposStore } from '../../store/repos'
import { planSync, unionRepos } from '../remote/peerSync'

export const PAIR_SYNC_INTERVAL_MS = 60_000
const LAST_SYNC_KEY = 'minmo-pair-sync'
const MAX_RETRY = 3

const EMPTY_DOC: SyncDoc = { settings: [], notes: [] }
const count = (d: SyncDoc) => d.settings.length + d.notes.length
// nowMs 는 내보낼 때마다 달라지므로 같은 내용인지 견줄 때는 뺀다
const sameDoc = (a: SyncDoc, b: SyncDoc) => JSON.stringify([a.settings, a.notes]) === JSON.stringify([b.settings, b.notes])
const sameRepos = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

// 페어마다 따로 둔다 — 다른 페어로 바꿨을 때 지난 페어의 시각으로 충돌을 가리지 않게
function readLast(pairId: string): number {
  try {
    return Number(localStorage.getItem(`${LAST_SYNC_KEY}:${pairId}`)) || 0
  } catch {
    return 0
  }
}
function writeLast(pairId: string, at: number) {
  try {
    localStorage.setItem(`${LAST_SYNC_KEY}:${pairId}`, String(at))
  } catch {
    // 못 쓰면 다음에 처음 맞추는 것처럼 한다(충돌 사본이 더 생길 수 있을 뿐이다)
  }
}

export interface PairSyncDeps {
  client: PairSyncClient
  api: Pick<ApiClient, 'syncExport' | 'syncImport'>
  pairId: string
  token: string
  myName: string
  now?: () => number
  onApplied?: () => void
}

/** 한 번 맞춘다. 서버 사본이 그 사이 바뀌었으면(409) 다시 읽어 맞춘다. 이 PC 에 넣은 수를 돌려준다 */
export async function pairSyncOnce(d: PairSyncDeps): Promise<{ moved: number; conflicts: number }> {
  let moved = 0
  let conflicts = 0
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const remote = await d.client.get(d.pairId, d.token)
    // 다른 기기가 올린 값이므로 모양을 믿지 않는다(깨진 사본이 모든 기기의 동기화를 막지 않게)
    const p = remote.payload && typeof remote.payload === 'object' ? remote.payload : {}
    const theirs: SyncDoc = p.doc && Array.isArray(p.doc.settings) && Array.isArray(p.doc.notes) ? p.doc : EMPTY_DOC
    const theirRepos = Array.isArray(p.repos) ? p.repos.filter((x): x is string => typeof x === 'string' && /^[^/\s]+\/[^/\s]+$/.test(x)) : []
    const startedAt = (d.now ?? Date.now)()
    const mine = await d.api.syncExport()

    const plan = planSync(mine, theirs, readLast(d.pairId), { mine: d.myName, theirs: '다른 PC' })
    if (count(plan.toMine) > 0) {
      const r = await d.api.syncImport(plan.toMine)
      if (r.skipped > 0) {
        // 그 사이 이 PC 에서 고쳤다 — 다시 읽고 맞춘다
        continue
      }
      moved += count(plan.toMine)
      d.onApplied?.()
    }
    const repos = useReposStore.getState()
    const u = unionRepos(repos.added, theirRepos)
    for (const full of u.addMine) repos.addGitHub(...splitFullName(full))
    moved += u.addMine.length

    // 올릴 사본 = 이 PC 의 현재 내용(받은 것을 넣은 뒤). 서버 사본과 같으면 올리지 않는다
    const merged: SyncDoc = count(plan.toMine) > 0 ? await d.api.syncExport() : mine
    const payload: PairPayload = { doc: { settings: merged.settings, notes: merged.notes, nowMs: merged.nowMs }, repos: u.all }
    if (sameDoc(merged, theirs) && sameRepos(u.all, theirRepos)) {
      writeLast(d.pairId, startedAt)
      return { moved, conflicts: conflicts + plan.conflicts }
    }
    try {
      await d.client.put(d.pairId, d.token, remote.rev, payload)
      writeLast(d.pairId, startedAt)
      return { moved, conflicts: conflicts + plan.conflicts }
    } catch (e) {
      if (!(e instanceof PairSyncError && e.status === 409)) throw e
      conflicts += plan.conflicts
    }
  }
  throw new Error('다른 PC 가 계속 고치고 있어 맞추지 못했습니다. 잠시 뒤 다시 시도하세요')
}

export type PairSyncStatus = { busy: boolean; at: number | null; error: string | null; moved: number }
export const usePairSyncStatus = create<{ s: PairSyncStatus; set(p: Partial<PairSyncStatus>): void }>()((set) => ({
  s: { busy: false, at: null, error: null, moved: 0 },
  set: (p) => set((st) => ({ s: { ...st.s, ...p } })),
}))

export interface PairRunDeps {
  tauri: Pick<TauriApi, 'keychainGet' | 'deviceName'>
  api: Pick<ApiClient, 'syncExport' | 'syncImport'>
  onApplied?: () => void
  now?: () => number
}

/** 연결되어 있으면 한 번 맞추고 결과를 화면 상태에 남긴다(겹쳐 돌지 않는다) */
export async function runPairSync(deps: PairRunDeps): Promise<void> {
  const { url, pairId } = usePairStore.getState()
  const st = usePairSyncStatus.getState()
  if (!pairId || !url || st.s.busy) return
  st.set({ busy: true, error: null })
  try {
    const token = await deps.tauri.keychainGet(KEYCHAIN_KEYS.pairToken)
    if (!token) throw new Error('연결 정보가 없습니다. 다시 연결하세요')
    const myName = (await deps.tauri.deviceName().catch(() => '')) || '이 PC'
    const r = await pairSyncOnce({ client: createPairSyncClient(url), api: deps.api, pairId, token, myName, now: deps.now, onApplied: deps.onApplied })
    usePairSyncStatus.getState().set({ busy: false, at: (deps.now ?? Date.now)(), moved: r.moved })
  } catch (e) {
    usePairSyncStatus.getState().set({ busy: false, error: e instanceof Error ? e.message : String(e) })
  }
}

/** 이 PC 의 창에서만: 연결된 동안 붙자마자 한 번, 그 뒤 일정 간격으로 맞춘다 */
export function usePairSync(tauri: TauriApi, deps: Omit<PairRunDeps, 'tauri'>) {
  const pairId = usePairStore((s) => s.pairId)
  useEffect(() => {
    if (tauri.runtime !== 'native' || !pairId) return
    const run = () => void runPairSync({ ...deps, tauri })
    run()
    const t = setInterval(run, PAIR_SYNC_INTERVAL_MS)
    return () => clearInterval(t)
    // deps 는 앱이 떠 있는 동안 같은 것을 넘긴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tauri, pairId])
}
