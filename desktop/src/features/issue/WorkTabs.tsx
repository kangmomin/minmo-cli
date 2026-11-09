import { useMemo, useRef } from 'react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { worktreeId } from '../../lib/worktree'
import type { IssueTarget } from '../../lib/worktree'
import { useSetupStore } from '../../store/setup'
import type { IssueOpenState } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import type { WorkTab } from '../../store/ui'
import { ChangesTab } from '../changes/ChangesTab'
import { NotesTab } from '../notes/NotesTab'
import { TerminalTab } from '../terminal/TerminalTab'

/**
 * 작업 탭: 터미널 · 변경 · 메모. 각 패널은 role=tabpanel + aria-labelledby 로 탭과 연결된다(Radix TabsContent).
 * 터미널은 이슈 전환에도 세션을 유지하도록 항상 마운트하고 hidden 만 토글한다.
 */
export interface WorkTabsProps {
  target: IssueTarget
  state: IssueOpenState | undefined
}

export function WorkTabs({ target, state }: WorkTabsProps) {
  const tab = useUiStore((s) => s.tab)
  const setTab = useUiStore((s) => s.setTab)
  const open = useSetupStore((s) => s.open)
  const id = worktreeId(target.owner, target.repo, target.key)
  const terminalTrigger = useRef<HTMLButtonElement>(null)

  const sessions = useMemo(
    () => Object.entries(open).flatMap(([issueId, s]) => (s.phase === 'ready' ? [{ issueId, cwd: s.path }] : [])),
    [open],
  )

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as WorkTab)} className="min-h-0 flex-1 gap-0">
      <TabsList className="mx-3 mt-2">
        <TabsTrigger ref={terminalTrigger} value="terminal">
          터미널
        </TabsTrigger>
        <TabsTrigger value="changes">변경</TabsTrigger>
        <TabsTrigger value="notes">메모</TabsTrigger>
      </TabsList>
      <div className="relative min-h-0 flex-1">
        {/* forceMount 는 Radix 가 hidden 을 풀어 버리므로 직접 토글한다 */}
        {/* 패널 안에 포커스 가능한 요소가 있으면 패널 자체는 Tab 정지점에서 뺀다 — 보이지 않는 정지점 방지(AX-19) */}
        <TabsContent value="terminal" forceMount hidden={tab !== 'terminal'} tabIndex={-1} className="absolute inset-0">
          <TerminalTab
            sessions={sessions}
            activeId={id}
            visible={tab === 'terminal'}
            // Ctrl+Shift+M: 터미널 밖(탭 목록)으로 포커스 이동 — 화살표로 다른 탭, Tab 으로 다음 영역(AX-02)
            onExit={() => terminalTrigger.current?.focus()}
          />
        </TabsContent>
        {/* 준비 전(안내 문구뿐)에는 포커스 가능한 내용이 없으므로 패널이 tabIndex 0 을 유지한다(tabs.tsx 가 포커스 링을 그린다) */}
        <TabsContent value="changes" tabIndex={state?.phase === 'ready' ? -1 : 0} className="absolute inset-0">
          {state?.phase === 'ready' ? (
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
          )}
        </TabsContent>
        <TabsContent value="notes" tabIndex={-1} className="absolute inset-0">
          <NotesTab key={id} owner={target.owner} repo={target.repo} issueKey={target.key} />
        </TabsContent>
      </div>
    </Tabs>
  )
}
