// 원격 터미널의 연결 상태(pty-link)를 패널 하나에 맞춰 받는다(#89).
import { useCallback, useEffect, useRef, useState } from 'react'

import type { PtyLink, PtyLinkEvent, TauriApi, Unlisten } from '../../lib/tauri'

/** 다시 접속했다는 안내(③)를 보이는 시간(D-25) */
export const JUST_CONNECTED_MS = 3000

const linkOf = ({ id: _id, ...link }: PtyLinkEvent): PtyLink => link

export interface PtyLinkState {
  /**
   * pty-link 를 구독한다 — id 가 정해지기 전(ptyFind 전)에 불러 그 사이의 이벤트도 놓치지 않는다.
   * 부를 때마다 id 를 비운다(지금 상태·seq 는 그대로) — 다시 구독할 때 이전 id 가 남아 있어도 setId 까지 온 이벤트는 보관된다
   */
  attach(): Promise<Unlisten>
  /** 이 패널의 PTY id 를 정한다. snapshot 은 ptyFind 가 돌려준 지금 상태(seq 가 큰 쪽을 쓴다). 지금 상태와 다른 PTY 면 처음 상태에서 시작한다 */
  setId(id: string, snapshot?: PtyLink | null): void
  /** 지금 상태 — null 이면 연결됨(Live) */
  link: PtyLink | null
  /** 방금 다시 접속했으면(실시간 connecting → connected) 그 시각(HH:MM), 3초 뒤 null */
  justConnectedAt: string | null
  /** 렌더 밖(콜백)에서 읽는 지금 상태 — 읽기만 한다(바꾸는 것은 이 훅뿐) */
  linkRef: { readonly current: PtyLink | null }
  /** [다시 시작] 등으로 새 PTY 를 만들 때 처음 상태로 */
  reset(): void
}

/**
 * tauri: attach 를 부를 때의 가장 최근 값으로 구독한다
 * onEvent: 이 패널의 새 상태(실시간 이벤트)를 받아들일 때마다 — 화면에 그리기 전에 부른다
 * (바뀌기 전 화면의 포커스 위치를 보거나, 뒤따르는 출력보다 먼저 할 일을 한다)
 *
 * attach·setId·reset·linkRef 는 tauri·onEvent 가 바뀌어도 늘 같은 값이다(useCallback·useRef — 둘은 ref 로 읽는다) — 성능이 아니라 정확성 때문이다:
 * attach·setId·linkRef 는 TerminalTab 의 터미널 세션 effect 의존성이라, 바뀌면 그 effect 가 터미널 화면을 다시 만든다
 */
export function usePtyLink(tauri: Pick<TauriApi, 'onPtyLink'>, onEvent?: (e: PtyLinkEvent) => void): PtyLinkState {
  const [link, setLink] = useState<PtyLink | null>(null)
  const [justConnectedAt, setJustConnectedAt] = useState<string | null>(null)
  const linkRef = useRef<PtyLink | null>(null)
  // id: 이벤트를 받아들일 PTY(정해지기 전·다시 구독한 뒤 null), owner: 지금 상태(seq·link)가 속한 PTY,
  // seq: 받아들인 마지막 상태의 번호, early: id 가 정해지기 전에 온 id 별 최신 상태
  const cur = useRef({
    id: null as string | null,
    owner: null as string | null,
    seq: -1,
    early: new Map<string, PtyLinkEvent>(),
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  })
  const tauriRef = useRef(tauri)
  const onEventRef = useRef(onEvent)
  useEffect(() => {
    tauriRef.current = tauri
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
    c.owner = null
    c.seq = -1
    c.early.clear()
    clearTimeout(c.timer)
    linkRef.current = null
    setLink(null)
    setJustConnectedAt(null)
  }, [])

  const attach = useCallback(() => {
    // 다시 구독할 때(터미널 화면을 다시 만들 때) 이전 id 가 남아 있으면 setId 전에 온 이벤트를 이전 id 와 견주게 된다 —
    // 부르는 순서에 기대지 않게 여기서 비운다. 지금 상태·seq 는 setId 가 같은 PTY 면 이어 쓰고 다른 PTY 면 버린다
    cur.current.id = null
    return tauriRef.current.onPtyLink((e) => {
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
    })
  }, [apply])

  const setId = useCallback(
    (id: string, snapshot?: PtyLink | null) => {
      const c = cur.current
      const early = c.early.get(id)
      // 다른 터미널(새로 만든 PTY)이면 이전 터미널의 상태를 이어받지 않는다
      if (c.owner !== null && c.owner !== id) reset()
      c.early.clear()
      c.id = id
      c.owner = id
      // ptyFind 의 지금 상태와 그 사이에 온 이벤트 중 더 새것
      const best = early && (!snapshot || early.seq > snapshot.seq) ? linkOf(early) : (snapshot ?? null)
      if (best && best.seq > c.seq) apply(best, false)
    },
    [apply, reset],
  )

  return { attach, setId, link, justConnectedAt, linkRef, reset }
}
