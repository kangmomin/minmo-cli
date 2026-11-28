import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { aliasOfIssue, hostOf, useHostDeps } from '../../app/host'
import { useHostsStore } from '../../store/hosts'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { useAgentStore } from '../agents/agentStore'
import { ago } from '../agents/overview'
import type { AgentRow } from '../agents/overview'
import { parseLastReply, replyPreview } from './claudeReply'

/** Why: 기다리는 상태가 된 뒤 읽기까지의 틈 — Claude Code 가 마지막 답을 기록에 쓸 시간 */
const READ_DELAY_MS = 1500

/** Why: updatedMs = 기록이 바뀐 시각(기록이 없으면 null) */
type Reply = { lines: string[]; updatedMs: number | null }

export function ClaudeReply({ row }: { row: AgentRow | null }) {
  const on = useUiStore((s) => s.summaryClaudeReply)
  const alias = row ? aliasOfIssue(row.issueId) : null
  // Why: useHost() 는 연결 전 원격을 이 PC 로 바꾼다 — 그 줄의 호스트를 직접 봐야 이 PC 의 기록을 대신 읽지 않는다
  const connected = useHostsStore((s) => alias === null || s.probes[alias] !== undefined)
  if (!on || !row || row.agent !== 'claude' || row.peer || !connected) return null
  return <ReplyBox row={row} alias={alias} />
}

function ReplyBox({ row, alias }: { row: AgentRow; alias: string | null }) {
  const { paneId, issueId, waitingSince, since } = row
  const hostDeps = useHostDeps()
  // Why: 기본(#120)은 worktree 가 없다 — 작업 폴더(홈)는 열기 상태에만 있다(useAgentTracker 와 같다)
  const openPath = useSetupStore((s) => {
    const open = s.open[issueId]
    return open?.phase === 'ready' ? open.path : null
  })
  const cwd = useUiStore((s) => s.worktreePathMap[issueId]?.path ?? openPath)
  // Why: 같은 작업 폴더에 Claude Code 가 여럿이면 어느 기록이 이 패널 것인지 알 수 없다
  const crowded = useAgentStore((s) => Object.values(s.panes).filter((p) => p.agent === 'claude' && p.issueId === issueId).length > 1)

  // Why: 작업 구간마다 다른 키 — 다시 작업 중이 되면 앞 작업 구간에 읽은 답을 캐시에서 꺼내지 않는다
  const span = waitingSince ?? `working-${since}`
  // Why: 기다리기 시작하고 1.5초 뒤에 읽는다 — 타이머가 지금 키에 대해 끝났을 때만 읽기를 켠다
  const key = `${paneId}\n${span}`
  const [due, setDue] = useState<string | null>(null)
  useEffect(() => {
    if (crowded) return
    const t = setTimeout(() => setDue(key), waitingSince === null ? 0 : Math.max(0, waitingSince + READ_DELAY_MS - Date.now()))
    return () => clearTimeout(t)
  }, [key, waitingSince, crowded])

  const q = useQuery({
    queryKey: ['claudeReply', paneId, span],
    queryFn: async (): Promise<Reply> => {
      const tail = cwd === null ? null : await hostDeps(hostOf(alias)).tauri.claudeLastReply(cwd)
      const text = tail && parseLastReply(tail.tail)
      return { lines: text ? replyPreview(text) : [], updatedMs: tail?.updatedMs ?? null }
    },
    enabled: !crowded && due === key,
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
    // Why: 같은 패널을 다시 읽는 동안은 지난 답을 두고, 다른 세션으로 바뀌면 지난 세션의 답을 보이지 않는다
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === paneId ? prev : undefined),
    // Why: 기록이 기다림보다 먼저 쓰였으면 마지막 답을 아직 쓰는 중일 수 있다 — 이 키에서 한 번만 더 읽는다(실패한 읽기도 센다)
    refetchInterval: (query) => {
      const at = query.state.data?.updatedMs
      const reads = query.state.dataUpdateCount + query.state.errorUpdateCount
      return at != null && waitingSince !== null && at < waitingSince && reads < 2 ? READ_DELAY_MS : false
    },
  })

  // Why: "N분 전 기록" 이 흐르게 한다
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  let body: ReactNode = null
  let when = ''
  if (crowded) body = <p>같은 폴더에 Claude Code 가 여럿이라 고를 수 없습니다</p>
  else if (q.isError) body = <p>답변 기록을 읽지 못했습니다</p>
  else if (q.data?.lines.length === 0) body = <p className="text-muted-foreground">최근 기록에 답변이 없습니다</p>
  else if (q.data) {
    body = q.data.lines.map((line, i) => (
      <p key={i} className="truncate">
        {line}
      </p>
    ))
    if (q.data.updatedMs !== null) when = ` · ${ago(Date.now() - q.data.updatedMs)} 전 기록`
  }

  return (
    <div data-testid="claude-reply" className="grid min-w-0 gap-0.5 text-xs">
      <p className="text-muted-foreground">Claude Code 마지막 답변{when}</p>
      {body}
    </div>
  )
}
