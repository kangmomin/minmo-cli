// 원격 화면의 주소 # 뒤에 실려 오는 것 — 다른 PC 의 minmo 앱이 이 화면을 자기 안에 열 때 붙인다(features/remote/PeerView.tsx).
//   device=<기기 토큰>   이 화면이 호스트에 붙을 때 쓸 토큰(등록 화면을 건너뛴다)
//   open=<JSON>          열자마자 보여 줄 이슈·터미널 패널
import { useEffect } from 'react'

import type { IssueTarget } from '@minmo/core'

import { useIssueActions } from '../issue/useWorktree'
import { useUiStore } from '../../store/ui'

export type DeepLink = { device: string | null; open: { target: IssueTarget; paneId: string | null } | null }

const OPEN_EVENT = 'minmo-open'
let pendingOpen: DeepLink['open'] = null

export function parseHash(hash: string): DeepLink {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  let open: DeepLink['open'] = null
  try {
    const raw = JSON.parse(params.get('open') ?? 'null') as { target?: Partial<IssueTarget>; paneId?: unknown } | null
    const t = raw?.target
    if (t && typeof t.owner === 'string' && typeof t.repo === 'string' && typeof t.key === 'string' && typeof t.title === 'string' && (t.number === null || typeof t.number === 'number')) {
      open = { target: { owner: t.owner, repo: t.repo, key: t.key, number: t.number, title: t.title }, paneId: typeof raw.paneId === 'string' ? raw.paneId : null }
    }
  } catch {
    // 모양이 맞지 않으면 무시한다
  }
  return { device: params.get('device') || null, open }
}

/**
 * 주소의 # 뒤를 읽고 지운다(토큰이 주소창·기록에 남지 않게). 받은 토큰을 돌려주고, "열 곳"은 화면이 준비되면 처리하게 넘긴다.
 * 화면이 떠 있는 동안 # 뒤가 바뀌어도(다른 곳을 열라는 요청) 같은 방식으로 처리한다.
 */
export function consumeHash(win: Window = window): string | null {
  if (win.location.hash.length <= 1) return null
  const link = parseHash(win.location.hash)
  win.history.replaceState(null, '', win.location.pathname + win.location.search)
  if (link.open) {
    pendingOpen = link.open
    win.dispatchEvent(new Event(OPEN_EVENT))
  }
  return link.device
}

/** 작업 화면이 뜬 뒤: 넘겨받은 이슈를 열고 터미널 탭·그 패널로 간다 */
export function useDeepLinkOpen() {
  const actions = useIssueActions()
  useEffect(() => {
    const run = () => {
      const open = pendingOpen
      if (!open) return
      pendingOpen = null
      void Promise.resolve(actions.open(open.target)).then(() => {
        const ui = useUiStore.getState()
        ui.setTab('terminal')
        const issueId = ui.selectedIssueId
        if (issueId && open.paneId) ui.focusPane(issueId, open.paneId)
      })
    }
    run()
    window.addEventListener(OPEN_EVENT, run)
    return () => window.removeEventListener(OPEN_EVENT, run)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 처음 한 번만 건다(actions 는 매 렌더 새 객체일 수 있다)
  }, [])
}
