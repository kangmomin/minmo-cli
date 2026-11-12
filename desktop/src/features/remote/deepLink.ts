// 원격 화면의 주소 # 뒤에 실려 오는 것 — 다른 PC 의 minmo 앱이 이 화면을 자기 창으로 열 때 붙인다(src-tauri/src/remote.rs peer_url).
//   device=<기기 토큰>   이 화면이 호스트에 붙을 때 쓸 토큰(등록 화면을 건너뛴다)
//   open=<JSON>          열자마자 보여 줄 이슈·터미널 패널
// 주소는 누구나 만들 수 있다(링크를 눌러 들어올 수 있다). 그래서:
//   · 받은 토큰은 실제로 붙어 본 뒤에만 저장한다 — 엉뚱한 토큰이 든 링크가 등록을 지우지 못한다
//   · "열 곳"은 이 화면이 쓰는 토큰과 같은 토큰이 함께 온 경우에만 따른다 — 토큰을 모르는 쪽이 만든 링크로는
//     호스트에서 저장소를 받아 오고 스크립트를 돌리는 일(이슈 열기)을 시킬 수 없다
import { useEffect } from 'react'

import type { IssueTarget } from '@minmo/core'

import { storedDeviceToken } from '../../lib/tauri.remote'
import { useUiStore } from '../../store/ui'
import { useIssueActions } from '../issue/useWorktree'

export type DeepLink = { device: string | null; open: { target: IssueTarget; paneId: string | null } | null }

const OPEN_EVENT = 'minmo-open'
let pending: { open: NonNullable<DeepLink['open']>; device: string } | null = null

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
 * 주소의 # 뒤를 읽고 지운다(토큰이 주소창·기록에 남지 않게). 함께 온 토큰을 돌려준다.
 * "열 곳"은 토큰과 함께 왔을 때만 기억해 두고, 화면이 준비되면(useDeepLinkOpen) 토큰을 확인한 뒤 처리한다.
 */
export function consumeHash(win: Window = window): string | null {
  if (win.location.hash.length <= 1) return null
  const link = parseHash(win.location.hash)
  win.history.replaceState(null, '', win.location.pathname + win.location.search)
  if (link.open && link.device) {
    pending = { open: link.open, device: link.device }
    win.dispatchEvent(new Event(OPEN_EVENT))
  }
  return link.device
}

/** 기억해 둔 "열 곳"을 꺼낸다 — 함께 온 토큰이 이 화면이 쓰는 토큰과 같을 때만 돌려준다(아니면 버린다) */
export function takePendingOpen(tokenInUse: string | null): NonNullable<DeepLink['open']> | null {
  const p = pending
  pending = null
  return p && tokenInUse !== null && p.device === tokenInUse ? p.open : null
}

/** 작업 화면이 뜬 뒤: 넘겨받은 이슈를 열고 터미널 탭·그 패널로 간다 */
export function useDeepLinkOpen() {
  const actions = useIssueActions()
  useEffect(() => {
    const run = () => {
      if (!pending) return
      const open = takePendingOpen(storedDeviceToken())
      if (!open) return
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
