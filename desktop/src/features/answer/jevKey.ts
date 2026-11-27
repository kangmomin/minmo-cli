// Jev API 키 저장 여부(#122) — 서버 설정의 "세션 요약" 절과 요약 카드의 Jev 판정이 같이 쓴다. 키 원문은 화면으로 읽지 않는다
import { create } from 'zustand'

import type { TauriApi } from '../../lib/tauri'

interface JevKeyState {
  /** 키체인에 키가 있는가(아직 모르면 null) */
  saved: boolean | null
  /** 마지막 확인이 실패했는가 */
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

/** 앞뒤 공백을 떼고 보이는 ASCII(0x21~0x7E)만 — Rust(commands/jev.rs valid_key)와 같은 검사 */
const VALID_KEY = /^[\x21-\x7e]+$/

/** 키 저장 버튼·서버 설정 [저장]이 같이 쓴다 — 실패하면 Error(오류 코드)로 거절한다 */
export async function saveJevKey(tauri: TauriApi, raw: string): Promise<void> {
  const key = raw.trim()
  if (!VALID_KEY.test(key)) throw new Error('jev_key_invalid')
  await tauri.jevKeySet(key)
  useJevKeyStore.getState().set(true)
}
