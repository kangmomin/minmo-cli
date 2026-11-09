// dev(VITE_TAURI_MOCK=1)·Playwright 용 인메모리 가짜 TauriApi.
import type { TauriApi } from './tauri'

export type TauriMockOptions = {
  home?: string
  platform?: 'win32' | 'darwin' | 'linux'
}

// STUB (Phase 6.1 Red)
export function createTauriMock(_opts?: TauriMockOptions): TauriApi {
  throw new Error('not implemented')
}
