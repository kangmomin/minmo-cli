// 원격 터미널의 연결 상태(pty-link)를 패널 하나에 맞춰 받는다(#89).
// TODO(#89 5.2): Red 단계의 빈 스텁 — 구현은 Plan v6 §8
import { useRef } from 'react'

import type { PtyLink, TauriApi, Unlisten } from '../../lib/tauri'

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

export function usePtyLink(tauri: Pick<TauriApi, 'onPtyLink'>): PtyLinkState {
  void tauri
  const linkRef = useRef<PtyLink | null>(null)
  return { attach: async () => () => {}, setId: () => {}, link: null, justConnectedAt: null, linkRef, reset: () => {} }
}
