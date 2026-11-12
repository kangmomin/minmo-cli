// 다른 PC 의 화면을 이 앱 안에 연다 — 그 PC 가 내주는 웹 화면(원격 접속과 같은 것)을 그대로 쓴다.
import { useEffect, useRef, useState } from 'react'

import type { Peer } from '../../lib/tauri'
import type { PeerOpen } from '../../store/peers'

/**
 * 그 PC 의 화면 주소. 기기 토큰과 "열 곳"은 주소의 # 뒤에 붙인다 — # 뒤는 서버로 보내지지 않고(기록에 남지 않는다)
 * 그 화면(features/remote/deepLink.ts)이 읽은 뒤 지운다.
 */
export function peerSrc(peer: Pick<Peer, 'url' | 'token'>, open: (PeerOpen & { token: number }) | null): string {
  const params = new URLSearchParams()
  if (peer.token) params.set('device', peer.token)
  if (open) {
    params.set('open', JSON.stringify({ target: open.target, paneId: open.paneId }))
    // 같은 곳을 다시 눌러도 주소가 달라져 그 화면이 다시 처리한다
    params.set('n', String(open.token))
  }
  return `${peer.url}/#${params.toString()}`
}

export function PeerView({ peer, open }: { peer: Peer; open: (PeerOpen & { token: number }) | null }) {
  const frame = useRef<HTMLIFrameElement>(null)
  // 처음 주소로 한 번만 불러오고, 그 뒤 "열 곳"이 바뀌면 # 뒤만 바꾼다(화면을 다시 불러오지 않는다)
  const [initial] = useState(() => peerSrc(peer, open))
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (open && frame.current) frame.current.src = peerSrc(peer, open)
  }, [peer, open])

  if (!peer.token) {
    return (
      <p role="alert" className="p-6 text-sm text-destructive">
        {peer.name} 의 등록 정보를 읽을 수 없습니다. [원격 접속] 에서 지우고 다시 등록하세요.
      </p>
    )
  }
  return <iframe ref={frame} title={`${peer.name} 의 minmo`} src={initial} className="min-h-0 w-full flex-1 border-0" allow="clipboard-read; clipboard-write" data-testid="peer-frame" />
}
