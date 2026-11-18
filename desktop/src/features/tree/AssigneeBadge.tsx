import { Badge } from '../../components/ui/badge'

export interface AssigneeBadgeProps {
  /** 담당자의 login 목록 — 비어 있으면 아무것도 그리지 않는다 */
  assignees: string[]
  /** 내 login(useMyLogin) — 아직 모르면 null */
  me: string | null
  /** true 면 모든 login 을 보인다(이슈 머리줄). 기본은 한 명 + 나머지 수(좁은 트리 행) */
  full?: boolean
  className?: string
}

/** 이슈 담당자 배지(#86). 내가 담당자면 내 login 을 앞에 두고 색으로 구분한다 */
export function AssigneeBadge({ assignees, me, full = false, className }: AssigneeBadgeProps) {
  if (assignees.length === 0) return null
  const mine = me !== null && assignees.includes(me)
  const ordered = mine ? [me, ...assignees.filter((a) => a !== me)] : assignees
  const text = full ? ordered.map((a) => `@${a}`).join(', ') : `@${ordered[0]}${ordered.length > 1 ? ` +${ordered.length - 1}` : ''}`
  const label = `담당자: ${ordered.join(', ')}`
  return (
    <Badge variant={mine ? 'default' : 'outline'} className={className} title={label} data-testid="issue-assignees" data-mine={mine ? 'true' : undefined}>
      {/* "+1" 은 누구인지 알 수 없다 — 스크린 리더에는 전체 목록을 읽게 한다 */}
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{label}</span>
    </Badge>
  )
}
