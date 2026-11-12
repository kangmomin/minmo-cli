// PC 사이 동기화 — 등록한 다른 PC 와 메모·설정(이름을 정하는 값)·저장소 목록을 맞춘다.
// 등록한 쪽(이 PC)이 두 PC 의 내용을 모두 읽어 어느 쪽이 더 새로운지 가리고, 각자에게 필요한 것만 보낸다.
//   · 메모: 같은 메모가 다르면 나중에 고친 쪽을 쓴다. 밀린 쪽도 지난 동기화 뒤에 고친 것이면 그 내용을 "충돌 사본"으로
//     메모 끝에 붙여 양쪽에 둔다(지워지지 않게).
//   · 설정: 브랜치 이름 틀·기타 브랜치 이름·sparse 경로만. 나중에 고친 쪽을 쓰되, 손대지 않은 기본값은 고친 값을 이기지 못한다.
//   · 저장소 목록(GitHub 저장소): 더하기만 맞춘다 — 한쪽에서 뺀 것을 다른 쪽에서 빼지는 않는다.
// 맞추지 않는 것: 실행되는 값(생성 후 스크립트·작업 폴더 경로·에이전트 실행 명령) — 다른 PC 가 이 PC 에서 실행될 명령을
// 정하게 두지 않는다(서버도 이 경로로는 그 값들을 바꾸지 않는다). 그리고 로컬 저장소·작업 폴더, SSH 호스트, 로그인 정보, 기기별 설정.
//
// 두 PC 의 시계는 다를 수 있다. 각 서버가 알려 준 "지금"으로 차이를 재서, 그 PC 의 수정 시각을 이 PC 의 시계로 옮겨 견준다.
import type { QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { create } from 'zustand'

import type { ApiClient, SyncDoc, SyncNote, SyncSetting } from '@minmo/api-client'

import { SHARED_CONFLICT } from '../../lib/sharedState'
import type { Peer, SharedValue, TauriApi } from '../../lib/tauri'
import type { RemoteConnection } from '../../lib/tauri.remote'
import { usePeersStore } from '../../store/peers'
import { splitFullName, useReposStore } from '../../store/repos'
import { useUiStore } from '../../store/ui'
import { peerConnection, usePeerAgentsStore } from './peerAgents'

/** 붙어 있는 동안 이 간격으로 다시 맞춘다 */
export const SYNC_INTERVAL_MS = 60_000
const MAX_NOTE_BYTES = 1024 * 1024
const LAST_SYNC_KEY = 'minmo-peer-sync'
/** 전역 설정의 기본값(서버 settings.Defaults 와 같다) — 손대지 않은 기본값인지 가릴 때 쓴다 */
export const DEFAULT_GLOBAL = { branchTemplate: 'issue/{number}-{slug}', etcBranchName: 'etc', sparsePaths: '' } as const

const settingKey = (s: Pick<SyncSetting, 'scope' | 'owner' | 'repo'>) => `${s.scope}|${s.owner}|${s.repo}`
const noteKey = (n: Pick<SyncNote, 'owner' | 'repo' | 'key'>) => `${n.owner}/${n.repo}#${n.key}`
const FIELDS = ['branchTemplate', 'etcBranchName', 'sparsePaths'] as const
const sameSetting = (a: SyncSetting, b: SyncSetting) => FIELDS.every((f) => (a[f] ?? '') === (b[f] ?? ''))
const isDefaultGlobal = (s: SyncSetting) => s.scope === 'global' && FIELDS.every((f) => (s[f] ?? '') === DEFAULT_GLOBAL[f])
const bytes = (s: string) => new TextEncoder().encode(s).length

export type SyncPlan = { toMine: SyncDoc; toTheirs: SyncDoc; conflicts: number }

/** 충돌 사본의 머리줄 — 누구의 언제 내용인지 */
export function conflictHeader(name: string, atMs: number): string {
  return `\n\n---\n충돌 사본 — ${name}, ${new Date(atMs).toISOString().slice(0, 16).replace('T', ' ')} (UTC)\n\n`
}

/** 수정 시각을 다른 PC 의 시계로 옮긴다 */
export function shiftDoc(doc: SyncDoc, byMs: number): SyncDoc {
  if (byMs === 0) return doc
  return { ...doc, settings: doc.settings.map((s) => ({ ...s, updatedAtMs: s.updatedAtMs + byMs })), notes: doc.notes.map((n) => ({ ...n, updatedAtMs: n.updatedAtMs + byMs })) }
}

/**
 * 두 PC 의 내용을 견주어 각자에게 보낼 것을 정한다. 시각은 모두 이 PC 의 시계로 옮긴 값이어야 한다(shiftDoc).
 * lastSyncMs 는 이 두 PC 가 마지막으로 깨끗이 맞춘 시각(처음이면 0).
 *   · 받는 쪽 서버는 "자기 것보다 더 새로운 것"만 넣으므로, 보내는 것에는 항상 밀린 쪽보다 뒤의 시각을 붙인다
 *   · 같은 시각에 다르게 고친 경우에도 두 PC 가 같은 결론을 내도록, 시각이 같으면 내용의 글자 순서로 가린다
 */
export function planSync(mine: SyncDoc, theirs: SyncDoc, lastSyncMs: number, names: { mine: string; theirs: string }): SyncPlan {
  const plan: SyncPlan = { toMine: { settings: [], notes: [] }, toTheirs: { settings: [], notes: [] }, conflicts: 0 }
  const after = (winnerAt: number, loserAt: number) => Math.max(winnerAt, loserAt + 1)

  const theirSettings = new Map(theirs.settings.map((s) => [settingKey(s), s]))
  const mySettings = new Map(mine.settings.map((s) => [settingKey(s), s]))
  for (const [k, m] of mySettings) {
    const t = theirSettings.get(k)
    if (!t) {
      // 전역 설정은 각 PC 에 로그인할 때 생긴다 — 없는 쪽에 만들어 주지 않는다
      if (m.scope !== 'global') plan.toTheirs.settings.push(m)
      continue
    }
    if (sameSetting(m, t)) continue
    // 손대지 않은 기본값은 고친 값을 이기지 못한다(새로 설치한 PC 의 기본값이 "더 새롭다"고 다듬어 둔 설정을 덮지 않게)
    const mineWins =
      isDefaultGlobal(m) !== isDefaultGlobal(t)
        ? isDefaultGlobal(t)
        : m.updatedAtMs !== t.updatedAtMs
          ? m.updatedAtMs > t.updatedAtMs
          : JSON.stringify(FIELDS.map((f) => m[f])) > JSON.stringify(FIELDS.map((f) => t[f]))
    if (mineWins) plan.toTheirs.settings.push({ ...m, updatedAtMs: after(m.updatedAtMs, t.updatedAtMs) })
    else plan.toMine.settings.push({ ...t, updatedAtMs: after(t.updatedAtMs, m.updatedAtMs) })
  }
  for (const [k, t] of theirSettings) if (!mySettings.has(k) && t.scope !== 'global') plan.toMine.settings.push(t)

  const theirNotes = new Map(theirs.notes.map((n) => [noteKey(n), n]))
  const myNotes = new Map(mine.notes.map((n) => [noteKey(n), n]))
  for (const [k, m] of myNotes) {
    const t = theirNotes.get(k)
    if (!t) {
      plan.toTheirs.notes.push(m)
      continue
    }
    if (m.body === t.body) continue
    const mineWins = m.updatedAtMs !== t.updatedAtMs ? m.updatedAtMs > t.updatedAtMs : m.body > t.body
    const [winner, loser, loserName] = mineWins ? [m, t, names.theirs] : [t, m, names.mine]
    // 밀린 쪽도 지난 동기화 뒤에 고친 것이면(둘 다 고쳤다) 그 내용을 버리지 않고 붙여 둔다
    const bothEdited = loser.updatedAtMs > lastSyncMs && loser.body.trim() !== '' && !winner.body.includes(loser.body)
    const merged = bothEdited ? winner.body + conflictHeader(loserName, loser.updatedAtMs) + loser.body : null
    if (merged !== null && bytes(merged) <= MAX_NOTE_BYTES) {
      // 합친 내용은 양쪽 어느 것과도 다르므로 둘 다에 넣는다(둘보다 새로운 시각으로)
      const both: SyncNote = { ...winner, body: merged, updatedAtMs: Math.max(m.updatedAtMs, t.updatedAtMs) + 1 }
      plan.toMine.notes.push(both)
      plan.toTheirs.notes.push(both)
      plan.conflicts++
    } else if (mineWins) plan.toTheirs.notes.push({ ...m, updatedAtMs: after(m.updatedAtMs, t.updatedAtMs) })
    else plan.toMine.notes.push({ ...t, updatedAtMs: after(t.updatedAtMs, m.updatedAtMs) })
  }
  for (const [k, t] of theirNotes) if (!myNotes.has(k)) plan.toMine.notes.push(t)
  return plan
}

/** 저장소 목록 합치기(대소문자 무시) — 합친 목록과 이 PC 에 더할 것 */
export function unionRepos(mine: string[], theirs: string[]): { all: string[]; addMine: string[] } {
  const has = (list: string[], x: string) => list.some((y) => y.toLowerCase() === x.toLowerCase())
  const addMine = theirs.filter((t) => !has(mine, t))
  return { all: [...theirs, ...mine.filter((m) => !has(theirs, m))], addMine }
}

export type PeerSyncStatus = { busy: boolean; at: number | null; error: string | null; /** 마지막으로 주고받은 수 */ moved: number; conflicts: number }
const EMPTY_STATUS: PeerSyncStatus = { busy: false, at: null, error: null, moved: 0, conflicts: 0 }

export interface PeerSyncState {
  status: Record<string, PeerSyncStatus>
  set(peerId: string, patch: Partial<PeerSyncStatus>): void
}

export const usePeerSyncStore = create<PeerSyncState>()((set) => ({
  status: {},
  set: (peerId, patch) => set((s) => ({ status: { ...s.status, [peerId]: { ...(s.status[peerId] ?? EMPTY_STATUS), ...patch } } })),
}))

function lastSync(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LAST_SYNC_KEY) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

function rememberSync(peerId: string, at: number) {
  try {
    localStorage.setItem(LAST_SYNC_KEY, JSON.stringify({ ...lastSync(), [peerId]: at }))
  } catch {
    // 저장소를 쓸 수 없으면 다음에 처음 맞추는 것처럼 한다(충돌 사본이 더 생길 수 있을 뿐이다)
  }
}

const count = (d: SyncDoc) => d.settings.length + d.notes.length

export interface SyncDeps {
  /** 이 PC 의 이름을 알아낸다(충돌 사본에 적는다) */
  tauri?: Pick<TauriApi, 'deviceName'>
  api: Pick<ApiClient, 'syncExport' | 'syncImport'>
  queryClient?: Pick<QueryClient, 'invalidateQueries'>
  now?: () => number
  myName?: string
}

/** 한 PC 와 한 번 맞춘다. 주고받은 수를 돌려준다 */
export async function syncWithPeer(peer: Pick<Peer, 'id' | 'name'>, conn: RemoteConnection, deps: SyncDeps): Promise<{ moved: number; conflicts: number }> {
  // 1) 메모·설정
  const [mine, theirsRaw] = await Promise.all([deps.api.syncExport(), conn.call<SyncDoc>('syncExport', [])])
  // 그 PC 의 시계가 이 PC 보다 얼마나 앞서는가(각 서버가 답한 "지금"의 차이 — 요청이 오가는 시간만큼의 오차는 있다)
  const skew = typeof mine.nowMs === 'number' && typeof theirsRaw.nowMs === 'number' ? theirsRaw.nowMs - mine.nowMs : 0
  const startedAt = mine.nowMs ?? (deps.now ?? Date.now)()
  const myName = deps.myName ?? ((await deps.tauri?.deviceName().catch(() => '')) || '다른 PC')
  const plan = planSync(mine, shiftDoc(theirsRaw, -skew), lastSync()[peer.id] ?? 0, { mine: myName, theirs: peer.name })
  let skipped = 0
  if (count(plan.toMine) > 0) {
    skipped += (await deps.api.syncImport(plan.toMine)).skipped
    // 열려 있는 메모·설정 화면이 새 값을 다시 읽게 한다
    void deps.queryClient?.invalidateQueries()
  }
  if (count(plan.toTheirs) > 0) skipped += (await conn.call<{ skipped?: number }>('syncImport', [shiftDoc(plan.toTheirs, skew)])).skipped ?? 0
  let moved = count(plan.toMine) + count(plan.toTheirs)

  // 2) 저장소 목록(더하기만). 그 PC 의 함께 쓰는 상태(shared/repos.json)를 읽어 고친 뒤 올린다
  const repos = useReposStore.getState()
  const got = await conn.call<SharedValue>('sharedGet', ['repos'])
  let doc: Record<string, unknown> = {}
  try {
    doc = got.value ? (JSON.parse(got.value) as Record<string, unknown>) : {}
  } catch {
    doc = {}
  }
  const theirAdded = Array.isArray(doc.added) ? doc.added.filter((x): x is string => typeof x === 'string' && /^[^/\s]+\/[^/\s]+$/.test(x)) : []
  const u = unionRepos(repos.added, theirAdded)
  if (u.all.length !== theirAdded.length) {
    try {
      await conn.call('sharedSet', ['repos', JSON.stringify({ ...doc, added: u.all }), 'peer-sync', got.rev])
      moved += u.all.length - theirAdded.length
    } catch (e) {
      // 그 사이 그 PC 의 화면이 저장했으면 이번에는 넘어간다(다음에 맞춘다). 그 밖의 실패는 알린다
      if (!String(e instanceof Error ? e.message : e).includes(SHARED_CONFLICT)) throw e
    }
  }
  for (const full of u.addMine) repos.addGitHub(...splitFullName(full))
  moved += u.addMine.length

  // 서버가 일부를 넣지 않았으면(그 사이에 그쪽에서 고쳤다 등) "맞춘 시각"을 앞당기지 않는다 —
  // 다음에 다시 견줄 때 둘 다 고친 것으로 보고 충돌 사본을 남기게 된다(조용히 덮지 않는다)
  if (skipped === 0) rememberSync(peer.id, startedAt)
  return { moved, conflicts: plan.conflicts }
}

/** 한 PC 와 맞추고 그 결과를 화면 상태에 남긴다(겹쳐 돌지 않는다) */
export async function runPeerSync(peer: Pick<Peer, 'id' | 'name'>, deps: SyncDeps): Promise<void> {
  const store = usePeerSyncStore.getState()
  if (store.status[peer.id]?.busy) return
  const conn = peerConnection(peer.id)
  if (!conn) return store.set(peer.id, { error: '연결되어 있지 않습니다' })
  store.set(peer.id, { busy: true, error: null })
  try {
    const r = await syncWithPeer(peer, conn, deps)
    usePeerSyncStore.getState().set(peer.id, { busy: false, at: (deps.now ?? Date.now)(), moved: r.moved, conflicts: r.conflicts })
  } catch (e) {
    usePeerSyncStore.getState().set(peer.id, { busy: false, error: e instanceof Error ? e.message : String(e) })
  }
}

/** 이 PC 의 창에서만: 붙어 있는 PC 와 주기적으로 맞춘다(붙자마자 한 번, 그 뒤 일정 간격) */
export function usePeerSync(tauri: TauriApi, deps: SyncDeps) {
  const enabled = useUiStore((s) => s.peerSync)
  const online = usePeerAgentsStore((s) => s.online)
  const onlineIds = Object.keys(online)
    .filter((id) => online[id])
    .sort()
    .join('\n')
  useEffect(() => {
    if (tauri.runtime !== 'native' || !enabled || onlineIds === '') return
    const run = () => {
      for (const id of onlineIds.split('\n')) {
        const peer = usePeersStore.getState().peers.find((p) => p.id === id)
        if (peer) void runPeerSync(peer, deps)
      }
    }
    run()
    const t = setInterval(run, SYNC_INTERVAL_MS)
    return () => clearInterval(t)
    // deps 는 앱이 떠 있는 동안 같은 것을 넘긴다(api·queryClient)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tauri, enabled, onlineIds])
}

/** 이 PC 의 화면: 다른 PC 가 이 PC 의 서버에 설정·메모를 넣었으면 다시 읽는다 */
export function useSyncApplied(tauri: TauriApi, queryClient: Pick<QueryClient, 'invalidateQueries'>) {
  useEffect(() => {
    let stop: (() => void) | null = null
    let disposed = false
    void tauri
      .onSyncApplied(() => void queryClient.invalidateQueries())
      .then((un) => {
        if (disposed) un()
        else stop = un
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      stop?.()
    }
  }, [tauri, queryClient])
}
