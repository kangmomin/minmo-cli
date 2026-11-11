import { create } from 'zustand'

import type { ServerStatus } from '../lib/tauri'

export interface ServerStore {
  /** 내장 서버 상태(server-status 이벤트) — null 이면 아직 모름 */
  status: ServerStatus | null
  /** 앱이 붙은 서버 주소 — 서버가 처음 준비될 때 정하고, 포트를 바꾸면 창을 새로 고쳐 다시 정한다 */
  baseUrl: string | null
  /** 서버 설정 대화상자(로그인 화면·헤더·오류 화면 어디서든 연다) */
  settingsOpen: boolean
  setStatus(s: ServerStatus): void
  setBaseUrl(url: string): void
  setSettingsOpen(open: boolean): void
}

export const useServerStore = create<ServerStore>()((set) => ({
  status: null,
  baseUrl: null,
  settingsOpen: false,
  setStatus: (status) => set({ status }),
  setBaseUrl: (baseUrl) => set({ baseUrl }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}))

export const openServerSettings = () => useServerStore.getState().setSettingsOpen(true)
