// Why: store 동작만 쓴다 — WorktreeProvider 없이 부를 수 있고 worktree 서비스·서버·GitHub 를 부르지 않는다
import type { Host } from '../../app/host'
import { DEFAULT_TARGET } from '../../lib/defaultWorkspace'
import { useHostsStore } from '../../store/hosts'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'

/** Why: 선택·작업 탭은 건드리지 않는다 — 열기 상태만 만든다 */
export function ensureDefaultOpen(issueId: string, home: string | null): void {
  const st = useSetupStore.getState()
  st.setTarget(issueId, DEFAULT_TARGET)
  if (home === null) return st.setOpen(issueId, { phase: 'error', code: 'host_not_connected', message: '호스트에 연결되지 않았습니다' })
  const prev = st.open[issueId]
  if (prev?.phase === 'ready' && prev.path === home) return
  st.setOpen(issueId, { phase: 'ready', path: home, branch: '', pathChanged: false })
}

export function openDefault(host: Host, home: string | null): void {
  const id = host.issueId(DEFAULT_TARGET.owner, DEFAULT_TARGET.repo, DEFAULT_TARGET.key)
  ensureDefaultOpen(id, home)
  const ui = useUiStore.getState()
  ui.selectIssue(id)
  ui.setTab('terminal')
}

/** Why: 원격인데 연결 정보(probe)가 없으면 null — 이 PC 의 홈으로 떨어지지 않게 한다 */
export function homeOf(alias: string | null, baseHome: string): string | null {
  if (alias === null) return baseHome
  return useHostsStore.getState().probes[alias]?.home ?? null
}
