// 여러 PC 의 에이전트 현황 — 등록한 다른 PC 에 붙어 그 PC 가 올려 둔 현황(줄 목록)을 받아 이 PC 의 통합 현황·알림에 쓴다.
// 반대쪽 일(이 PC 의 현황을 올리기)도 여기 있다: useAgentPublisher.
import { useEffect } from 'react'
import { create } from 'zustand'

import type { Peer, TauriApi } from '../../lib/tauri'
import { TAURI_EVENTS } from '../../lib/tauri'
import { RemoteConnection } from '../../lib/tauri.remote'
import { usePeersStore } from '../../store/peers'
import { useUiStore } from '../../store/ui'
import { STATUS_LABEL } from '../agents/agentStore'
import type { AgentStatus } from '../agents/agentStore'
import type { AgentRow } from '../agents/overview'

const STATUSES: readonly AgentStatus[] = ['working', 'attention', 'done', 'idle']
const RETRY_MS = 10_000
/** 현황이 바뀐 뒤 이만큼 모아서 올린다 */
export const PUBLISH_DELAY_MS = 400
/** 다른 PC 한 곳에서 받는 줄 수·글자 수의 상한 — 다른 PC 가 보낸 값을 그대로 믿지 않는다 */
export const MAX_PEER_ROWS = 200
const MAX_TEXT = 200
/** 다른 PC 한 곳의 알림은 이 시간 동안 이만큼만 띄운다(상태를 계속 뒤집어 알림을 쏟아내지 못하게) */
export const NOTIFY_WINDOW_MS = 60_000
export const NOTIFY_MAX = 5

/** 알림을 띄워도 되는가 — times 는 그 PC 의 최근 알림 시각들(이 함수가 고쳐 쓴다) */
export function allowNotify(times: number[], now: number): boolean {
  while (times.length > 0 && now - times[0] >= NOTIFY_WINDOW_MS) times.shift()
  if (times.length >= NOTIFY_MAX) return false
  times.push(now)
  return true
}

/** 올리는 줄에서 "마지막 출력 시각"은 10초 단위로 뭉친다 — 에이전트가 출력하는 동안 매초 바뀌어 매번 다시 올라가지 않게 */
export function forPublish(rows: AgentRow[]): AgentRow[] {
  return rows.map((r) => ({ ...r, lastOutputAt: Math.floor(r.lastOutputAt / 10_000) * 10_000 }))
}

export interface PeerAgentsState {
  /** PC id → 그 PC 의 에이전트 줄 */
  rows: Record<string, AgentRow[]>
  /** PC id → 붙어 있는가 */
  online: Record<string, boolean>
  setRows(peerId: string, rows: AgentRow[]): void
  setOnline(peerId: string, online: boolean): void
  forget(keep: string[]): void
}

export const usePeerAgentsStore = create<PeerAgentsState>()((set) => ({
  rows: {},
  online: {},
  setRows: (peerId, rows) => set((s) => ({ rows: { ...s.rows, [peerId]: rows } })),
  setOnline: (peerId, online) => set((s) => (s.online[peerId] === online ? s : { online: { ...s.online, [peerId]: online }, rows: online ? s.rows : { ...s.rows, [peerId]: [] } })),
  forget: (keep) => set((s) => ({ rows: Object.fromEntries(Object.entries(s.rows).filter(([k]) => keep.includes(k))), online: Object.fromEntries(Object.entries(s.online).filter(([k]) => keep.includes(k))) })),
}))

/** 붙어 있는 PC 의 연결 — 동기화(peerSync.ts)가 같은 연결로 그 PC 를 부른다 */
const connections = new Map<string, RemoteConnection>()
export const peerConnection = (peerId: string): RemoteConnection | null => connections.get(peerId) ?? null

/** 다른 PC 가 보낸 줄 — 모양이 맞는 것만 받고, 그 PC 의 것임을 표시한다 */
export function parsePeerRows(raw: unknown, peer: Pick<Peer, 'id' | 'name'>): AgentRow[] {
  if (!Array.isArray(raw)) return []
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '')
  const seen = new Set<string>()
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return raw.slice(0, MAX_PEER_ROWS).flatMap((r: unknown): AgentRow[] => {
    if (typeof r !== 'object' || r === null) return []
    const o = r as Record<string, unknown>
    if (typeof o.paneId !== 'string' || typeof o.issueId !== 'string' || !STATUSES.includes(o.status as AgentStatus)) return []
    // 같은 패널이 두 번 오면 처음 것만 쓴다
    if (seen.has(o.paneId)) return []
    seen.add(o.paneId)
    const host = typeof o.host === 'string' ? o.host : null
    return [
      {
        paneId: o.paneId,
        issueId: o.issueId,
        host,
        // 그 PC 의 SSH 호스트에서 도는 것이면 함께 적는다
        hostLabel: host ? `${peer.name} · ${host}` : peer.name,
        repo: str(o.repo),
        issue: str(o.issue),
        agent: (['claude', 'codex', 'gemini', 'other'] as const).includes(o.agent as 'claude') ? (o.agent as AgentRow['agent']) : 'other',
        agentLabel: str(o.agentLabel),
        label: str(o.label),
        status: o.status as AgentStatus,
        since: num(o.since),
        lastOutputAt: num(o.lastOutputAt),
        subagents: Array.isArray(o.subagents)
          ? (o.subagents as AgentRow['subagents']).slice(0, 50).filter((s) => typeof s === 'object' && s !== null && typeof s.id === 'string' && typeof s.type === 'string' && typeof s.description === 'string')
          : [],
        running: num(o.running),
        target: typeof o.target === 'object' && o.target !== null ? (o.target as AgentRow['target']) : null,
        peer: { id: peer.id, name: peer.name },
      },
    ]
  })
}

/** 방금 끝났거나 입력을 기다리게 된 줄 — 알림 대상(그 전에도 같은 상태였거나 처음 보는 줄은 뺀다) */
export function newlyUrgent(prev: AgentRow[], next: AgentRow[]): AgentRow[] {
  const before = new Map(prev.map((r) => [r.paneId, r.status]))
  return next.filter((r) => r.agent !== 'other' && (r.status === 'done' || r.status === 'attention') && before.has(r.paneId) && before.get(r.paneId) !== r.status)
}

const wsUrl = (url: string) => `${url.replace(/^http/, 'ws')}/ws`
// 모듈에 한 번만 둔다 — 인자의 기본값으로 매번 새 함수를 만들면 렌더할 때마다 연결을 끊고 다시 붙는다
const defaultConnect = (url: string, token: string) => new RemoteConnection(wsUrl(url), token)

/** 이 PC 의 창에서만: 등록한 PC 마다 붙어 현황을 받는다. 끊기면 다시 붙는다 */
export function usePeerAgents(tauri: TauriApi, connect: (url: string, token: string) => RemoteConnection = defaultConnect) {
  const peers = usePeersStore((s) => s.peers)
  // 목록은 앱이 뜰 때 한 번 읽는다(등록·삭제는 설정 화면이 store 를 갱신한다)
  useEffect(() => {
    if (tauri.runtime !== 'native') return
    void tauri
      .peersList()
      .then((list) => usePeersStore.getState().setPeers(list))
      .catch(() => undefined)
  }, [tauri])

  // 주소·토큰이 같으면 다시 붙지 않는다
  const sig = peers.map((p) => `${p.id}|${p.url}|${p.token ?? ''}|${p.name}`).join('\n')
  useEffect(() => {
    if (tauri.runtime === 'remote') return
    const store = usePeerAgentsStore.getState()
    const list = usePeersStore.getState().peers
    store.forget(list.map((p) => p.id))
    const stops = list.map((peer) => {
      if (!peer.token) return () => {}
      let stopped = false
      let conn: RemoteConnection | null = null
      let timer: ReturnType<typeof setTimeout> | undefined
      const notified: number[] = []
      const apply = (raw: unknown) => {
        const s = usePeerAgentsStore.getState()
        const next = parsePeerRows(raw, peer)
        const urgent = newlyUrgent(s.rows[peer.id] ?? [], next)
        s.setRows(peer.id, next)
        if (!useUiStore.getState().agentNotify) return
        for (const r of urgent) {
          if (!allowNotify(notified, Date.now())) break
          void tauri.notify(`${peer.name}: ${r.agentLabel} — ${STATUS_LABEL[r.status]}`, [r.repo, r.issue].filter(Boolean).join(' ')).catch(() => undefined)
        }
      }
      const open = () => {
        if (stopped) return
        const c = connect(peer.url, peer.token!)
        conn = c
        c.on(TAURI_EVENTS.agentsChanged, apply)
        c.onLink((link) => {
          if (stopped || conn !== c) return
          if (link === 'closed' || link === 'rejected') {
            if (connections.get(peer.id) === c) connections.delete(peer.id)
            usePeerAgentsStore.getState().setOnline(peer.id, false)
            // 거절(그 PC 에서 이 PC 를 끊음)은 다시 시도해도 같으므로 그만둔다 — 다시 등록해야 한다
            if (link === 'closed') timer = setTimeout(open, RETRY_MS)
          }
        })
        c.connect()
          .then(async () => {
            if (stopped || conn !== c) return
            connections.set(peer.id, c)
            usePeerAgentsStore.getState().setOnline(peer.id, true)
            // 처음 받은 것은 알리지 않는다(기준이 될 뿐이다)
            usePeerAgentsStore.getState().setRows(peer.id, parsePeerRows(await c.call('agentsSnapshot', []), peer))
          })
          .catch(() => undefined)
      }
      open()
      return () => {
        stopped = true
        clearTimeout(timer)
        if (conn && connections.get(peer.id) === conn) connections.delete(peer.id)
        conn?.close()
      }
    })
    return () => stops.forEach((s) => s())
    // sig: 주소·토큰·이름이 바뀐 PC 가 있을 때만 다시 붙는다(목록 객체가 새로 만들어진 것만으로는 다시 붙지 않는다)
  }, [tauri, sig, connect])
}

/** 이 PC 의 창에서만: 이 PC 의 에이전트 현황을 올려 둔다 — 이 PC 를 등록한 다른 PC 가 받아 간다 */
export function useAgentPublisher(tauri: TauriApi, rows: AgentRow[]) {
  // 내용이 같으면(뭉친 뒤) 다시 올리지 않는다
  const json = JSON.stringify(forPublish(rows))
  useEffect(() => {
    if (tauri.runtime !== 'native') return
    const t = setTimeout(() => void tauri.agentsPublish(JSON.parse(json) as unknown[]).catch(() => undefined), PUBLISH_DELAY_MS)
    return () => clearTimeout(t)
  }, [tauri, json])
}
