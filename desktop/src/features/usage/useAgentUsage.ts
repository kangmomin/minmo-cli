// 지금 보는 호스트(이 영역의 HostScope)의 AI 별 사용량을 주기적으로 읽는다
import { useQuery } from '@tanstack/react-query'

import { useDeps } from '../../app/deps'
import { useHost } from '../../app/host'
import { useHostsStore } from '../../store/hosts'

/** 다시 읽는 간격 — 기록 파일을 훑으므로(원격은 ssh 한 번) 자주 읽지 않는다 */
export const USAGE_POLL_MS = 60_000

/** 이 화면의 오늘 자정(ms) — "오늘 쓴 양"의 기준 */
export function startOfToday(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

export function useAgentUsage(enabled: boolean) {
  const { tauri } = useDeps()
  const host = useHost()
  // 원격 호스트는 연결을 확인한 뒤에만 읽는다(확인 전에는 ssh 가 물어보며 멈출 수 있다)
  const connected = useHostsStore((s) => host.alias === null || s.probes[host.alias] !== undefined)
  return useQuery({
    queryKey: ['agentUsage', host.id],
    // 자정이 지나면 다음 조회부터 새 날의 값이다
    queryFn: () => tauri.agentUsage(startOfToday()),
    enabled: enabled && connected,
    refetchInterval: USAGE_POLL_MS,
    // 창이 숨겨져 있으면 쉬고, 다시 보일 때 읽는다
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: USAGE_POLL_MS / 2,
    // 읽지 못하면 조용히 넘어간다 — 사용량은 부가 정보다
    retry: false,
  })
}
