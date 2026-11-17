// 하단 바 — 지금 보는 호스트의 AI 별 사용량을 한 줄로 보인다. 한도 사용률을 아는 도구(Codex)는 %, 모르는 도구는 오늘 쓴 토큰 수.
import { useHost } from '../../app/host'
import { cn } from '../../lib/utils'
import { useUiStore } from '../../store/ui'
import { AGENT_LABEL } from '../agents/detect'
import type { AgentUsage } from '../../lib/tauri'
import { effectivePercent, formatTokens, limitLevel, limitsDetail, tokensDetail, totalTokens, windowLabel } from './format'
import type { LimitLevel } from './format'
import { useAgentUsage } from './useAgentUsage'

/** 바에는 짧은 이름을 쓴다(상세에는 AGENT_LABEL 의 정식 이름) */
const SHORT: Record<'claude' | 'codex' | 'gemini', string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }

// 색만으로 구분하지 않는다 — 높은 값에는 글자도 붙인다(LEVEL_NOTE)
const LEVEL_CLASS: Record<LimitLevel, string> = { ok: '', high: 'text-amber-600 dark:text-amber-400', full: 'font-medium text-destructive' }
const LEVEL_NOTE: Record<LimitLevel, string> = { ok: '', high: ' 높음', full: ' 한도 도달' }

type Item = { key: string; text: string; detail: string; level: LimitLevel }

/** 보일 것이 있는 도구만 — 기록 폴더가 없거나(쓰지 않는 도구) 오늘 쓴 것이 없으면 뺀다 */
export function usageItems(u: AgentUsage, now: number): Item[] {
  const items: Item[] = []
  const tokens = (key: 'claude' | 'gemini') => {
    const t = u[key]
    if (t && totalTokens(t) > 0) items.push({ key, text: `${SHORT[key]} ${formatTokens(totalTokens(t))} 오늘`, detail: tokensDetail(AGENT_LABEL[key], t), level: 'ok' })
  }
  tokens('claude')
  if (u.codex) {
    const c = u.codex
    const percents = c.limits.map((l) => effectivePercent(l, now))
    if (c.limits.length > 0) {
      const level = limitLevel(Math.max(...percents))
      const text = `${SHORT.codex} ${c.limits.map((l, i) => `${windowLabel(l.windowMinutes)} ${percents[i]}%`).join(' ')}${LEVEL_NOTE[level]}`
      items.push({ key: 'codex', text, detail: limitsDetail(AGENT_LABEL.codex, c, now), level })
    } else if (totalTokens(c.tokens) > 0) {
      // 한도 기록이 없는 버전·요금제 — 토큰 수로 대신한다
      items.push({ key: 'codex', text: `${SHORT.codex} ${formatTokens(totalTokens(c.tokens))} 오늘`, detail: tokensDetail(AGENT_LABEL.codex, c.tokens), level: 'ok' })
    }
  }
  tokens('gemini')
  return items
}

export function UsageBar() {
  const show = useUiStore((s) => s.showUsage)
  const host = useHost()
  const usage = useAgentUsage(show)
  if (!show) return null
  // 읽은 시각을 "지금"으로 쓴다 — 값이 같아도 읽을 때마다 다시 그려, 초기화 시각이 지난 한도가 옛 % 로 남지 않는다
  const items = usage.data ? usageItems(usage.data, usage.dataUpdatedAt || Date.now()) : []
  const noPython = usage.data?.unavailable === 'python3'
  // 켜져 있으면 값이 없어도(읽는 중·호스트 전환·기록 없음) 같은 높이로 둔다 — 바가 생겼다 없어지면 그때마다
  // 작업 영역의 높이가 바뀌어 터미널이 크기를 다시 맞춘다(전체 화면 프로그램이 화면을 다시 그린다)
  return (
    <footer
      data-testid="usage-bar"
      aria-label={`AI 사용량 — ${host.label}`}
      className="flex h-6 shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-t px-3 text-xs text-muted-foreground"
    >
      <span className="shrink-0 font-medium" data-testid="usage-host">
        {host.label}
      </span>
      {noPython && (
        <span title="원격 호스트에 python3 이 있어야 AI 사용량을 읽을 수 있습니다" data-testid="usage-unavailable">
          사용량을 읽을 수 없음(python3 필요)
        </span>
      )}
      {usage.data && items.length === 0 && !noPython && <span data-testid="usage-empty">오늘 AI 사용 기록 없음</span>}
      <ul className="flex min-w-0 items-center gap-2 overflow-hidden">
        {items.map((it, i) => (
          // title 은 마우스용 상세다. 같은 내용을 스크린 리더에도 읽히게 aria-label 로 둔다
          <li key={it.key} title={it.detail} aria-label={it.detail.replace(/\n/g, ', ')} data-testid={`usage-${it.key}`} className={cn('truncate', LEVEL_CLASS[it.level])}>
            {i > 0 && <span aria-hidden className="mr-2 text-muted-foreground/60">·</span>}
            {it.text}
          </li>
        ))}
      </ul>
    </footer>
  )
}
