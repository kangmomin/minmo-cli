// 화면 키보드에 없는 키 줄 — 휴대폰·태블릿에서 터미널(에이전트 CLI)을 쓸 때 Esc·Tab·방향키·Ctrl+C 를 누를 수 있게 한다.
import { useSyncExternalStore } from 'react'

/** 패널 id → 그 터미널에 "사용자가 친 것처럼" 글자를 넣는 함수(TerminalTab 이 등록한다) */
const inputs = new Map<string, (data: string) => void>()

export function registerTerminalInput(paneId: string, send: (data: string) => void): () => void {
  inputs.set(paneId, send)
  return () => {
    if (inputs.get(paneId) === send) inputs.delete(paneId)
  }
}

export const KEY_BAR_KEYS: readonly { label: string; name: string; data: string }[] = [
  { label: 'Esc', name: 'Esc', data: '\x1b' },
  { label: 'Tab', name: 'Tab', data: '\t' },
  { label: '⇧Tab', name: 'Shift+Tab', data: '\x1b[Z' },
  { label: '↑', name: '위', data: '\x1b[A' },
  { label: '↓', name: '아래', data: '\x1b[B' },
  { label: '←', name: '왼쪽', data: '\x1b[D' },
  { label: '→', name: '오른쪽', data: '\x1b[C' },
  { label: '^C', name: 'Ctrl+C', data: '\x03' },
  { label: '줄바꿈', name: '줄바꿈(전송하지 않음)', data: '\x1b\r' },
  { label: 'Enter', name: 'Enter', data: '\r' },
]

function query(q: string) {
  const mql = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q) : null
  return {
    subscribe: (cb: () => void) => {
      mql?.addEventListener('change', cb)
      return () => mql?.removeEventListener('change', cb)
    },
    get: () => mql?.matches ?? false,
  }
}
const narrow = query('(max-width: 767px)')
const coarse = query('(pointer: coarse)')

/** 좁은 화면(휴대폰 폭)인가 */
export function useNarrow(): boolean {
  return useSyncExternalStore(narrow.subscribe, narrow.get, () => false)
}

/** 손가락으로 쓰는 기기인가(화면 키보드) */
export function useTouch(): boolean {
  return useSyncExternalStore(coarse.subscribe, coarse.get, () => false)
}

export function TerminalKeyBar({ paneId }: { paneId: string | null }) {
  return (
    <div role="toolbar" aria-label="터미널 키" className="flex shrink-0 gap-1 overflow-x-auto px-2 py-1" data-testid="terminal-key-bar">
      {KEY_BAR_KEYS.map((k) => (
        <button
          key={k.label}
          type="button"
          aria-label={k.name}
          // 누를 때 화면 키보드가 내려가지 않게 터미널의 포커스를 유지한다
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => paneId !== null && inputs.get(paneId)?.(k.data)}
          className="min-w-10 shrink-0 rounded border border-neutral-600 px-2 py-1.5 font-mono text-xs text-neutral-200 active:bg-neutral-700"
        >
          {k.label}
        </button>
      ))}
    </div>
  )
}
