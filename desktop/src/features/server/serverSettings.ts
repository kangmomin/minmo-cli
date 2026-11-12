import type { CloseAction, ServerStatus } from '../../lib/tauri'

export const CLOSE_OPTIONS: { value: CloseAction; label: string }[] = [
  { value: 'ask', label: '매번 묻기' },
  { value: 'tray', label: '트레이로 최소화(서버 유지)' },
  { value: 'quit', label: '종료' },
]

export function parsePort(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null
  const n = Number(raw.trim())
  return n >= 1024 && n <= 65535 ? n : null
}

export function statusText(s: ServerStatus | null): string {
  if (!s) return '확인 중…'
  switch (s.state) {
    case 'running':
      return `실행 중 · 127.0.0.1:${s.port}`
    case 'starting':
      return '시작 중…'
    case 'failed':
      return `오류 — ${s.message ?? '원인을 알 수 없습니다'}`
    case 'stopped':
      return '정지됨'
    case 'external':
      return '외부 서버 사용 중(개발 실행) — 저장한 값은 내장 서버를 쓸 때 적용됩니다'
  }
}
