// AI 사용량의 표시 글 — 하단 바의 짧은 글과 마우스를 올렸을 때의 상세
import type { CodexUsage, UsageLimit, UsageTokens } from '../../lib/tauri'

/** 합계 — 캐시에서 다시 읽은 입력은 넣지 않는다(요청마다 대화 전체가 다시 세어져 값이 수백 배가 된다) */
export const totalTokens = (t: UsageTokens): number => t.input + t.output + t.cacheWrite

/** 1234 → 1.2k, 1_234_567 → 1.2M. 1000 미만은 그대로 */
export function formatTokens(n: number): string {
  const short = (v: number, unit: string) => `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${unit}`
  if (n >= 999_500_000) return short(n / 1_000_000_000, 'B')
  if (n >= 999_500) return short(n / 1_000_000, 'M')
  if (n >= 1000) return short(n / 1000, 'k')
  return String(Math.round(n))
}

/** 한도 창의 이름: 300분 → 5h, 10080분 → 주. 그 밖은 일·시간·분 단위 */
export function windowLabel(minutes: number): string {
  if (minutes === 10080) return '주'
  if (minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440}일`
  if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}h`
  return minutes > 0 ? `${minutes}분` : '한도'
}

export type LimitLevel = 'ok' | 'high' | 'full'

/** 초기화 시각이 지난 한도는 다시 0 에서 시작한다(기록은 Codex 를 마지막으로 쓴 시점의 값이다) */
export function effectivePercent(l: UsageLimit, now: number): number {
  if (l.resetsAtMs > 0 && l.resetsAtMs <= now) return 0
  return Math.max(0, Math.round(l.usedPercent))
}

export const limitLevel = (percent: number): LimitLevel => (percent >= 100 ? 'full' : percent >= 80 ? 'high' : 'ok')

const clock = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 토큰 수의 상세(여러 줄) */
export function tokensDetail(label: string, t: UsageTokens): string {
  const lines = [`${label} — 오늘 ${totalTokens(t).toLocaleString()} 토큰`, `입력 ${t.input.toLocaleString()} · 출력 ${t.output.toLocaleString()}`]
  if (t.cacheWrite > 0) lines.push(`캐시에 쓴 입력 ${t.cacheWrite.toLocaleString()}`)
  if (t.cacheRead > 0) lines.push(`캐시에서 읽은 입력 ${t.cacheRead.toLocaleString()} (합계에 넣지 않음)`)
  return lines.join('\n')
}

/** Codex 한도의 상세(여러 줄) — 실시간 값이 아니라는 것과 기준 시각을 알린다 */
export function limitsDetail(label: string, u: CodexUsage, now: number): string {
  const lines = u.limits.map((l) => {
    const reset = l.resetsAtMs <= 0 ? '' : l.resetsAtMs <= now ? ' · 초기화됨' : ` · ${clock(l.resetsAtMs)} 초기화`
    return `${label} ${windowLabel(l.windowMinutes)} 한도 ${effectivePercent(l, now)}%${reset}`
  })
  if (u.limitsAtMs > 0) lines.push(`${clock(u.limitsAtMs)} 기준 — ${label} 를 마지막으로 쓴 시점의 값`)
  if (totalTokens(u.tokens) > 0) lines.push(tokensDetail(label, u.tokens))
  return lines.join('\n')
}
