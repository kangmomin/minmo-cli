import { useEffect } from 'react'
import { create } from 'zustand'

import type { TauriApi } from '../../lib/tauri'

interface JevKeyState {
  /** Why: 키체인에 키가 있는가(아직 모르면 null) */
  saved: boolean | null
  error: boolean
  refresh(tauri: TauriApi): Promise<void>
  set(saved: boolean): void
}

// Why: 확인이 늦게 끝나면 그 사이 저장·지우기 결과를 덮는다 — 요청 번호가 마지막 것일 때만 쓴다
let seq = 0

export const useJevKeyStore = create<JevKeyState>((setState) => ({
  saved: null,
  error: false,
  refresh: async (tauri) => {
    const n = ++seq
    try {
      const saved = await tauri.jevKeyStatus()
      if (n === seq) setState({ saved, error: false })
    } catch {
      if (n === seq) setState({ error: true })
    }
  },
  set: (saved) => {
    seq++
    setState({ saved, error: false })
  },
}))

export function useJevKeyStatus(tauri: TauriApi): { saved: boolean | null; checkFailed: boolean } {
  const saved = useJevKeyStore((s) => s.saved)
  const checkFailed = useJevKeyStore((s) => s.error)
  useEffect(() => {
    void useJevKeyStore.getState().refresh(tauri)
  }, [tauri])
  return { saved, checkFailed }
}

/** Why: 앞뒤 공백을 떼고 보이는 ASCII(0x21~0x7E)만 — Rust(commands/jev.rs valid_key)와 같은 검사 */
const VALID_KEY = /^[\x21-\x7e]+$/

/** Why: 키 저장 버튼·서버 설정 [저장]이 같이 쓴다 — 실패하면 Error(오류 코드)로 거절한다 */
export async function saveJevKey(tauri: TauriApi, raw: string): Promise<void> {
  const key = raw.trim()
  if (!VALID_KEY.test(key)) throw new Error('jev_key_invalid')
  await tauri.jevKeySet(key)
  useJevKeyStore.getState().set(true)
}
