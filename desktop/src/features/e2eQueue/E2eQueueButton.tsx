// 상단 바의 [E2E 큐] — 남은 작업(대기+실행 중) 수와, 실행 중 작업이 사용자 확인을 기다리면 "확인 필요"를 보인다(EC-23)
import { FlaskConicalIcon } from 'lucide-react'

import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip'
import { isActive, useE2eQueueStore } from './queueStore'
import type { E2eJob } from './queueStore'

/** 사용자가 패널을 봐야 하는 상태 — 'undetected' 는 결과 파일로 진행하므로 기다리기만 하면 된다 */
const needsCheck = (j: E2eJob) =>
  j.status === 'running' && (j.notice === 'attention' || j.notice === 'exited' || j.notice === 'unknown' || j.notice === 'nofile')

function buttonName(active: number, check: boolean): string {
  return `E2E 큐${active > 0 ? ` (${active})` : ''}${check ? ' — 확인 필요' : ''}`
}

export function E2eQueueButton({ onClick }: { onClick(): void }) {
  // 값(수·참거짓)만 골라 작업 목록이 바뀌어도 보이는 것이 같으면 다시 그리지 않는다
  const active = useE2eQueueStore((s) => s.jobs.filter(isActive).length)
  const check = useE2eQueueStore((s) => s.jobs.some(needsCheck))
  const name = buttonName(active, check)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={name}
          onClick={onClick}
          data-testid="e2e-queue-button"
          data-attention={check || undefined}
          className={check ? 'gap-1.5 text-amber-700 ring-1 ring-amber-500 dark:text-amber-400' : 'gap-1.5'}
        >
          <FlaskConicalIcon />
          {active > 0 && (
            <Badge
              variant={check ? 'outline' : 'secondary'}
              className={check ? 'border-amber-500 px-1.5 py-0 text-amber-700 dark:text-amber-400' : 'px-1.5 py-0'}
            >
              {active}
            </Badge>
          )}
          {check && <span className="text-xs">확인 필요</span>}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  )
}
