// 창 사이에서 "지금 보는 이슈"를 알린다(#105).
// OS 알림은 주 창만 띄운다. 그런데 사용자가 보조 창에서 그 이슈의 터미널을 보고 있으면 알리면 안 된다 —
// 그래서 포커스를 가진 창이 자기가 보는 이슈를 localStorage(모든 창이 함께 씀)에 적어 둔다.
import { useEffect } from 'react'

import { workTabOf } from '../../lib/defaultWorkspace'
import { useUiStore } from '../../store/ui'
import { selectedTabId } from '../terminal/panes'

const KEY = 'minmo-window-view'
/** 이 화면(창)의 id — 새로 고치면 바뀐다 */
const ME = Math.random().toString(36).slice(2)

/** Why: tab 은 창마다 따로 고른다. 패널이 없으면 null */
type View = { by: string; issueId: string | null; terminal: boolean; tab: string | null }

function readView(): View | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return typeof v === 'object' && v !== null && typeof (v as View).by === 'string' ? (v as View) : null
  } catch {
    return null
  }
}

/** Why: tabId 를 주면 그 창이 같은 터미널 탭을 볼 때만 본 것으로 친다 */
export function viewedInOtherWindow(issueId: string, tabId?: string | null): boolean {
  const v = readView()
  if (v === null || v.by === ME || v.issueId !== issueId || !v.terminal) return false
  // Why: 탭을 모르는 쪽(옛 값·모르는 패널)이 있으면 지금처럼 이슈만 본다
  return typeof tabId !== 'string' || typeof v.tab !== 'string' || v.tab === tabId
}

/** 이 창이 포커스를 가진 동안 보는 이슈를 적어 두고, 포커스를 잃거나 닫히면 지운다 */
export function useWindowViewBroadcast() {
  const issueId = useUiStore((s) => s.selectedIssueId)
  const terminal = useUiStore((s) => (s.selectedIssueId === null ? s.tab : workTabOf(s.selectedIssueId, s.tab)) === 'terminal')
  const tab = useUiStore((s) => {
    const p = s.selectedIssueId === null ? undefined : s.panes[s.selectedIssueId]
    return p ? selectedTabId(p.tree, p.tab) : null
  })
  useEffect(() => {
    const write = () => {
      try {
        if (document.hasFocus()) localStorage.setItem(KEY, JSON.stringify({ by: ME, issueId, terminal, tab } satisfies View))
      } catch {
        // 저장소를 쓸 수 없으면 알리지 않는다(주 창이 알림을 한 번 더 띄울 뿐이다)
      }
    }
    const clear = () => {
      try {
        if (readView()?.by === ME) localStorage.removeItem(KEY)
      } catch {
        // 위와 같다
      }
    }
    write()
    window.addEventListener('focus', write)
    window.addEventListener('blur', clear)
    window.addEventListener('pagehide', clear)
    return () => {
      window.removeEventListener('focus', write)
      window.removeEventListener('blur', clear)
      window.removeEventListener('pagehide', clear)
    }
  }, [issueId, terminal, tab])
}
