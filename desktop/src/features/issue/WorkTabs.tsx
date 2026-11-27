import { useMemo, useRef } from 'react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import type { IssueTarget } from '@minmo/core'
import { aliasOfIssue, useHost } from '../../app/host'
import { useHostsStore } from '../../store/hosts'
import { useSetupStore } from '../../store/setup'
import type { IssueOpenState } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import type { WorkTab } from '../../store/ui'
import { ChangesTab } from '../changes/ChangesTab'
import { FilesTab } from '../files/FilesTab'
import { NotesTab } from '../notes/NotesTab'
import { TerminalTab } from '../terminal/TerminalTab'
import { IssueTab } from './IssueTab'

/**
 * 작업 탭: 터미널 · 변경 · 파일 · 메모 · 이슈. 각 패널은 role=tabpanel + aria-labelledby 로 탭과 연결된다(Radix TabsContent).
 * 터미널은 이슈 전환에도 세션을 유지하도록 항상 마운트하고 hidden 만 토글한다.
 */
export interface WorkTabsProps {
  target: IssueTarget
  /** 이슈 id(호스트 접두어 포함). 없으면 이 영역의 호스트로 만든다 — 호스트에 연결하기 전에도 맞는 id 를 쓰도록 넘긴다 */
  issueId?: string
  state: IssueOpenState | undefined
  /** Why: 답변 모드(#122): 탭 목록 없이 지금 패널 하나의 터미널만 */
  terminalOnly?: boolean
  /** Why: 답변 모드(#122): Ctrl+Shift+M 이 포커스를 옮길 곳(기본 보기는 [터미널] 탭) */
  onExit?: () => void
  /** Why: 답변 모드(#122): 터미널 입력이 함께 읽을 설명 요소 id */
  describedBy?: string
}

export function WorkTabs({ target, issueId, state, terminalOnly = false, onExit, describedBy }: WorkTabsProps) {
  const tab = useUiStore((s) => s.tab)
  const setTab = useUiStore((s) => s.setTab)
  const open = useSetupStore((s) => s.open)
  const probes = useHostsStore((s) => s.probes)
  const useTmux = useHostsStore((s) => s.useTmux)
  const scopedId = useHost().issueId(target.owner, target.repo, target.key)
  const id = issueId ?? scopedId
  const terminalTrigger = useRef<HTMLButtonElement>(null)

  const sessions = useMemo(
    () =>
      Object.entries(open).flatMap(([issueId, s]) => {
        if (s.phase !== 'ready') return []
        // 다른 호스트의 이슈도 세션을 유지한다 — 원격이면 그 호스트로 ssh 터미널을 연다
        const alias = aliasOfIssue(issueId)
        return [{ issueId, cwd: s.path, remote: alias === null ? undefined : { host: alias, tmux: useTmux && (probes[alias]?.tmux ?? false) } }]
      }),
    [open, probes, useTmux],
  )
  const hasSession = sessions.some((s) => s.issueId === id)

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as WorkTab)} className="min-h-0 flex-1 gap-0">
      {!terminalOnly && (
        <TabsList className="mx-3 mt-2">
          <TabsTrigger ref={terminalTrigger} value="terminal">
            터미널
          </TabsTrigger>
          <TabsTrigger value="changes">변경</TabsTrigger>
          <TabsTrigger value="files">파일</TabsTrigger>
          <TabsTrigger value="notes">메모</TabsTrigger>
          <TabsTrigger value="issue">이슈</TabsTrigger>
        </TabsList>
      )}
      <div className="relative min-h-0 flex-1">
        {/* forceMount 는 Radix 가 hidden 을 풀어 버리므로 직접 토글한다 */}
        {/* 패널 안에 포커스 가능한 요소가 있으면 패널 자체는 Tab 정지점에서 뺀다 — 보이지 않는 정지점 방지(AX-19).
            세션이 없으면(안내 문구뿐) 0 을 유지하고(AX-37), 터미널 배경이 패널의 inset ring 을 덮으므로 ::after 오버레이로 링을 그린다 */}
        {/* Why: 답변 모드에는 탭 목록이 없다 — 이름 없는 tabpanel·없는 탭을 가리키는 aria-labelledby 를 남기지 않는다 */}
        <TabsContent
          value="terminal"
          forceMount
          hidden={tab !== 'terminal'}
          tabIndex={terminalOnly || hasSession ? -1 : 0}
          {...(terminalOnly ? { role: undefined, 'aria-labelledby': undefined } : {})}
          className="absolute inset-0 after:pointer-events-none after:absolute after:inset-0 focus-visible:after:ring-[3px] focus-visible:after:ring-inset focus-visible:after:ring-ring"
        >
          <TerminalTab
            sessions={sessions}
            activeId={id}
            visible={tab === 'terminal'}
            singlePane={terminalOnly}
            describedBy={terminalOnly ? describedBy : undefined}
            // Ctrl+Shift+M: 터미널 밖(탭 목록)으로 포커스 이동 — 화살표로 다른 탭, Tab 으로 다음 영역(AX-02)
            onExit={terminalOnly ? onExit : () => terminalTrigger.current?.focus()}
          />
        </TabsContent>
        {/* Why: Radix 는 선택 안 된 TabsContent 도 빈 tabpanel 로 남긴다 — 답변 모드에서는 그리지 않는다 */}
        {!terminalOnly && (
          <>
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
            <TabsContent value="files" tabIndex={state?.phase === 'ready' ? -1 : 0} className="absolute inset-0">
              {state?.phase === 'ready' ? (
                <FilesTab key={`${id}|${state.path}`} root={state.path} scope={id} />
              ) : (
                <p className="p-4 text-sm text-muted-foreground">worktree 가 준비되면 파일을 볼 수 있습니다.</p>
              )}
            </TabsContent>
            {/* 메모는 로딩·비활성 시 NotesTab 이 자체 Tab 정지점을 두므로 패널은 -1 (CR-20) */}
            <TabsContent value="notes" tabIndex={-1} className="absolute inset-0">
              <NotesTab key={id} owner={target.owner} repo={target.repo} issueKey={target.key} />
            </TabsContent>
            {/* Why: IssueTab 의 내용 영역이 Tab 정지점이므로 패널은 -1 (AX-19) */}
            <TabsContent value="issue" tabIndex={-1} className="absolute inset-0">
              <IssueTab key={id} target={target} />
            </TabsContent>
          </>
        )}
      </div>
    </Tabs>
  )
}
