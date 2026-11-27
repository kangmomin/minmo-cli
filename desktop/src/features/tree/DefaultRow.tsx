import { HomeIcon } from 'lucide-react'

import { useDeps } from '../../app/deps'
import { useHost } from '../../app/host'
import { DEFAULT_TARGET } from '../../lib/defaultWorkspace'
import { cn } from '../../lib/utils'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { IssueAgentDot } from '../agents/AgentBadge'
import { homeOf, openDefault } from '../issue/defaultOpen'

export function DefaultRow() {
  const host = useHost()
  const { home } = useDeps()
  const issueId = host.issueId(DEFAULT_TARGET.owner, DEFAULT_TARGET.repo, DEFAULT_TARGET.key)
  const selected = useUiStore((s) => s.selectedIssueId === issueId)

  return (
    <button
      type="button"
      data-testid="default-row"
      aria-current={selected ? 'true' : undefined}
      onClick={() => {
        // Why: 고르기 전에 본다 — 처음 여는 순간에는 터미널이 없다(IssueRow 와 같다)
        const ready = useSetupStore.getState().open[issueId]?.phase === 'ready'
        openDefault(host, homeOf(host.alias, home))
        if (ready) useUiStore.getState().focusIssueTerminal(issueId)
      }}
      className={cn('flex w-full items-center gap-1.5 overflow-hidden rounded px-2 py-1 text-left text-sm hover:bg-accent', selected && 'bg-accent font-medium')}
    >
      <span className="flex w-2 shrink-0 justify-center">
        <IssueAgentDot issueId={issueId} />
      </span>
      <HomeIcon aria-hidden className="size-3.5 shrink-0" />
      <span>기본</span>
      <span className="sr-only">저장소와 관계없는 작업 공간, 이 호스트의 홈 폴더</span>
    </button>
  )
}
