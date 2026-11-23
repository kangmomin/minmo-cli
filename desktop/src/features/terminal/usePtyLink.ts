// 원격 터미널의 연결 상태(pty-link)를 패널 하나에 맞춰 받는다(#89).
import { useCallback, useEffect, useRef, useState } from 'react'

import type { PtyLink, PtyLinkEvent, TauriApi, Unlisten } from '../../lib/tauri'

/** 다시 접속했다는 안내(③)를 보이는 시간(D-25) */
export const JUST_CONNECTED_MS = 3000

const linkOf = ({ id: _id, ...link }: PtyLinkEvent): PtyLink => link

export interface PtyLinkState {
  /** pty-link 를 구독한다 — id 가 정해지기 전(ptyFind 전)에 불러 그 사이의 이벤트도 놓치지 않는다 */
  attach(): Promise<Unlisten>
  /** 이 패널의 PTY id 를 정한다. snapshot 은 ptyFind 가 돌려준 지금 상태(seq 가 큰 쪽을 쓴다) */
  setId(id: string, snapshot?: PtyLink | null): void
  /** 지금 상태 — null 이면 연결됨(Live) */
  link: PtyLink | null
  /** 방금 다시 접속했으면(실시간 connecting → connected) 그 시각(HH:MM), 3초 뒤 null */
  justConnectedAt: string | null
  /** 렌더 밖(콜백)에서 읽는 지금 상태 */
  linkRef: { current: PtyLink | null }
  /** [다시 시작] 등으로 새 PTY 를 만들 때 처음 상태로 */
  reset(): void
}

/**
 * onEvent: 이 패널의 새 상태(실시간 이벤트)를 받아들일 때마다 — 화면에 그리기 전에 부른다
 * (바뀌기 전 화면의 포커스 위치를 보거나, 뒤따르는 출력보다 먼저 할 일을 한다)
 */
export function usePtyLink(tauri: Pick<TauriApi, 'onPtyLink'>, onEvent?: (e: PtyLinkEvent) => void): PtyLinkState {
  const [link, setLink] = useState<PtyLink | null>(null)
  const [justConnectedAt, setJustConnectedAt] = useState<string | null>(null)
  const linkRef = useRef<PtyLink | null>(null)
  // id: 이 패널의 PTY(정해지기 전 null), seq: 받아들인 마지막 상태의 번호, early: id 가 정해지기 전에 온 id 별 최신 상태
  const cur = useRef({ id: null as string | null, seq: -1, early: new Map<string, PtyLinkEvent>(), timer: undefined as ReturnType<typeof setTimeout> | undefined })
  const onEventRef = useRef(onEvent)
  useEffect(() => {
    onEventRef.current = onEvent
  })
  useEffect(() => {
    const c = cur.current
    return () => clearTimeout(c.timer)
  }, [])

  /** live: 실시간 이벤트(스냅샷·먼저 온 이벤트가 아님) — 다시 접속했다는 안내(③)는 그때만 */
  const apply = useCallback((next: PtyLink, live: boolean) => {
    const c = cur.current
    const before = linkRef.current
    const shown = next.phase === 'connected' ? null : next
    c.seq = next.seq
    linkRef.current = shown
    setLink(shown)
    // 새 상태가 오면 ③ 은 바로 내린다
    clearTimeout(c.timer)
    const at = live && shown === null && before?.phase === 'connecting' ? next.at : null
    setJustConnectedAt(at)
    if (at !== null) c.timer = setTimeout(() => setJustConnectedAt(null), JUST_CONNECTED_MS)
  }, [])

  const reset = useCallback(() => {
    const c = cur.current
    c.id = null
    c.seq = -1
    c.early.clear()
    clearTimeout(c.timer)
    linkRef.current = null
    setLink(null)
    setJustConnectedAt(null)
  }, [])

  const attach = useCallback(
    () =>
      tauri.onPtyLink((e) => {
        const c = cur.current
        if (c.id === null) {
          const seen = c.early.get(e.id)
          if (!seen || e.seq > seen.seq) c.early.set(e.id, e)
          return
        }
        // 다른 터미널의 상태, 늦게 온 옛 상태는 버린다
        if (e.id !== c.id || e.seq <= c.seq) return
        onEventRef.current?.(e)
        apply(linkOf(e), true)
      }),
    [tauri, apply],
  )

  const setId = useCallback(
    (id: string, snapshot?: PtyLink | null) => {
      const c = cur.current
      const early = c.early.get(id)
      // 다른 터미널(새로 만든 PTY)이면 이전 터미널의 상태를 이어받지 않는다
      if (c.id !== null && c.id !== id) reset()
      c.early.clear()
      c.id = id
      // ptyFind 의 지금 상태와 그 사이에 온 이벤트 중 더 새것
      const best = early && (!snapshot || early.seq > snapshot.seq) ? linkOf(early) : (snapshot ?? null)
      if (best && best.seq > c.seq) apply(best, false)
    },
    [apply, reset],
  )

  return { attach, setId, link, justConnectedAt, linkRef, reset }
}
