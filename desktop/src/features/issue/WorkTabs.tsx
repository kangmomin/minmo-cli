import { useMemo } from 'react'

import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { worktreeId } from '../../lib/worktree'
import type { IssueTarget } from '../../lib/worktree'
import { useSetupStore } from '../../store/setup'
import type { IssueOpenState } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import type { WorkTab } from '../../store/ui'
import { ChangesTab } from '../changes/ChangesTab'
import { NotesTab } from '../notes/NotesTab'
import { TerminalTab } from '../terminal/TerminalTab'

/** 작업 탭: 터미널 · 변경 · 메모. 터미널은 이슈 전환에도 세션을 유지하도록 항상 마운트한다 */
export function WorkTabs({ target, state }: { target: IssueTarget; state: IssueOpenState | undefined }) {
  const tab = useUiStore((s) => s.tab)
  const setTab = useUiStore((s) => s.setTab)
  const open = useSetupStore((s) => s.open)
  const id = worktreeId(target.owner, target.repo, target.key)

  const sessions = useMemo(
    () =>
      Object.entries(open).flatMap(([issueId, s]) => (s.phase === 'ready' ? [{ issueId, cwd: s.path }] : [])),
    [open],
  )

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as WorkTab)} className="min-h-0 flex-1 gap-0">
      <TabsList className="mx-3 mt-2">
        <TabsTrigger value="terminal">터미널</TabsTrigger>
        <TabsTrigger value="changes">변경</TabsTrigger>
        <TabsTrigger value="notes">메모</TabsTrigger>
      </TabsList>
      <div className="relative min-h-0 flex-1">
        <TerminalTab sessions={sessions} activeId={id} visible={tab === 'terminal'} />
        {tab === 'changes' &&
          (state?.phase === 'ready' ? (
            <ChangesTab
              key={id}
              target={{
                owner: target.owner,
                repo: target.repo,
                branch: state.branch,
                cwd: state.path,
                issue: { number: target.number, title: target.title },
              }}
            />
          ) : (
            <p className="p-4 text-sm text-muted-foreground">worktree 가 준비되면 변경 내역을 볼 수 있습니다.</p>
          ))}
        {tab === 'notes' && <NotesTab key={id} owner={target.owner} repo={target.repo} issueKey={target.key} />}
      </div>
    </Tabs>
  )
}
