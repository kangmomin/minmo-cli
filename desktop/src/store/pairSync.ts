// 설정 페어링 동기화 — 연결 정보(서버 URL·페어 id)만 화면에 둔다. 페어 토큰은 키체인(KEYCHAIN_KEYS.pairToken)에 둔다.
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export interface PairState {
  /** 동기화 서버 URL */
  url: string
  /** 연결된 페어 id. 없으면 연결 안 됨 */
  pairId: string | null
  link(url: string, pairId: string): void
  unlink(): void
  setUrl(url: string): void
}

export const usePairStore = create<PairState>()(
  persist(
    (set) => ({
      url: '',
      pairId: null,
      link: (url, pairId) => set({ url, pairId }),
      unlink: () => set({ pairId: null }),
      setUrl: (url) => set({ url }),
    }),
    { name: 'minmo-pair', storage: createJSONStorage(() => localStorage), partialize: (s) => ({ url: s.url, pairId: s.pairId }) },
  ),
)
