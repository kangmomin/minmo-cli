// 다른 PC(이 PC 가 원격으로 접속하는 minmo 호스트) — 목록은 Rust 가 갖고(설정 폴더 + 키체인의 토큰), 여기서는 화면이 볼 사본만 둔다.
import { create } from 'zustand'

import type { Peer } from '../lib/tauri'

export interface PeersState {
  peers: Peer[]
  setPeers(peers: Peer[]): void
}

export const usePeersStore = create<PeersState>()((set) => ({
  peers: [],
  setPeers: (peers) => set({ peers }),
}))
