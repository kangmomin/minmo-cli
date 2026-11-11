import { create } from 'zustand'

import type { UpdateInfo, UpdateProgress } from '../lib/tauri'

export interface UpdateStore {
  /** 확인된 새 버전(null = 없음·아직 모름) */
  available: UpdateInfo | null
  /** [나중에]를 누른 버전 — 같은 버전 안내는 다시 띄우지 않는다(직접 확인하면 다시 보인다) */
  dismissed: string | null
  installing: boolean
  progress: UpdateProgress | null
  error: string | null
  set(patch: Partial<Omit<UpdateStore, 'set'>>): void
}

export const useUpdateStore = create<UpdateStore>()((set) => ({
  available: null,
  dismissed: null,
  installing: false,
  progress: null,
  error: null,
  set: (patch) => set(patch),
}))
