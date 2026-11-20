// 원격 터미널 재접속 안내(#89) — ① 다시 접속하는 중 · ② 다시 접속하지 못함 · ③ 다시 접속했음(3초).
// TODO(#89 5.2): Red 단계의 빈 스텁 — 구현은 Plan v6 §8
import type { Ref } from 'react'

import type { PtyLink } from '../../lib/tauri'

export interface ReconnectNoticeProps {
  /** 지금 연결 상태 — null 이면 연결됨(Live) */
  link: PtyLink | null
  /** ③ 을 보이는 중이면 다시 접속한 시각(HH:MM) */
  justConnectedAt: string | null
  /** [지금 재접속]·[재접속] */
  onReconnect: () => void
  /** ①·② 의 버튼(같은 요소) — 실패로 바뀔 때 포커스를 옮기는 데 쓴다 */
  buttonRef?: Ref<HTMLButtonElement>
}

export function ReconnectNotice(props: ReconnectNoticeProps) {
  void props
  return null
}
