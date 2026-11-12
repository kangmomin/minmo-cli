// 다른 PC(이 PC 가 원격으로 접속하는 minmo 호스트) — 목록은 Rust 가 갖고(설정 폴더 + 키체인의 토큰), 여기서는 화면 상태만 둔다.
import { create } from 'zustand'

import type { IssueTarget } from '@minmo/core'

import type { Peer } from '../lib/tauri'

/** 그 PC 의 화면을 열면서 바로 보여 줄 이슈·터미널 패널(통합 현황의 줄을 눌렀을 때) */
export type PeerOpen = { target: IssueTarget; paneId: string | null }

export interface PeersState {
  peers: Peer[]
  /** 지금 화면에 열어 둔 PC(없으면 이 PC) */
  activeId: string | null
  /** 열면서 보여 줄 곳 — token 이 바뀔 때마다 그 PC 의 화면에 전달한다 */
  open: (PeerOpen & { token: number }) | null
  setPeers(peers: Peer[]): void
  setActive(id: string | null, open?: PeerOpen): void
}

export const usePeersStore = create<PeersState>()((set) => ({
  peers: [],
  activeId: null,
  open: null,
  // 열어 둔 PC 가 목록에서 빠졌으면 이 PC 로 돌아온다
  setPeers: (peers) => set((s) => ({ peers, activeId: s.activeId !== null && peers.some((p) => p.id === s.activeId) ? s.activeId : null })),
  setActive: (activeId, open) => set((s) => ({ activeId, open: open && activeId !== null ? { ...open, token: (s.open?.token ?? 0) + 1 } : null })),
}))
