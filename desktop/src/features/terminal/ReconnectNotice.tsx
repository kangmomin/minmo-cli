// 원격 터미널 재접속 안내(#89) — ① 다시 접속하는 중 · ② 다시 접속하지 못함 · ③ 다시 접속했음(3초).
import { RefreshCwIcon } from 'lucide-react'
import type { Ref } from 'react'

import { Button } from '../../components/ui/button'
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
  /** ①·② 문구의 id — 연결이 끊긴 동안 터미널 입력의 설명(aria-describedby)으로 쓰고, ② 에서는 [재접속] 의 설명으로도 쓴다 */
  messageId?: string
}

/** 재접속이 시작될 때 상태 알림 영역에 넣는 문구 — 시도 횟수가 바뀌어도 그대로 둬 다시 읽히지 않게 한다 */
const STARTED = '연결이 끊겨 다시 접속하는 중입니다'
const REASON: Record<NonNullable<PtyLink['reason']>, string> = { auth: '인증 실패', host_key: '호스트 키 확인 실패', spawn: '접속할 수 없음' }

/**
 * 종료 안내와 같은 자리·모양(xterm host 앞 — AX-34). role=alert 는 ② 문구에만 두고 버튼은 형제로 둔다(AX-35).
 * [지금 재접속] 과 [재접속] 은 같은 버튼 요소다 — ①↔② 가 바뀌어도 포커스가 남는다
 */
export function ReconnectNotice({ link, justConnectedAt, onReconnect, buttonRef, messageId }: ReconnectNoticeProps) {
  const failed = link?.phase === 'failed'
  const connecting = link?.phase === 'connecting'
  const done = link === null && justConnectedAt !== null ? `다시 접속했습니다 (${justConnectedAt})` : null
  // 상시 있는 상태 알림 영역 — 재접속이 시작될 때와 다시 접속했을 때만 읽힌다(②는 alert 가 알린다)
  const status = link !== null && !failed ? STARTED : (done ?? '')
  return (
    <>
      <div role="status" className="sr-only">
        {status}
      </div>
      {(link !== null || done !== null) && (
        <div className="absolute inset-x-2 bottom-2 z-10 flex flex-wrap items-center gap-3 rounded border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
          {failed ? (
            // 실패할 때마다 새로 마운트해 다시 읽히게 한다
            <p key={`failed-${link.seq}`} id={messageId} role="alert" className="flex-1">
              연결이 끊겼습니다. 다시 접속하지 못했습니다({link.reason ? REASON[link.reason] : `${link.attempt}번`})
            </p>
          ) : link !== null ? (
            <p id={messageId} className="flex flex-1 items-center gap-2">
              <RefreshCwIcon aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
              연결이 끊겼습니다. 다시 접속하는 중… ({link.attempt}/{link.max})
            </p>
          ) : (
            <p className="flex-1">{done}</p>
          )}
          {link !== null && (
            // 시도 중에는 누를 수 없음을 aria-disabled 로 알린다 — disabled 는 포커스를 잃게 해 쓰지 않는다.
            // ② 에서는 실패 이유를 버튼의 설명으로도 둔다 — 포커스가 [재접속] 으로 옮겨 온 뒤에도 들을 수 있게
            <Button
              ref={buttonRef}
              size="sm"
              variant="secondary"
              aria-disabled={connecting || undefined}
              aria-describedby={failed ? messageId : undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              onClick={() => {
                if (!connecting) onReconnect()
              }}
            >
              {failed ? '재접속' : '지금 재접속'}
            </Button>
          )}
        </div>
      )}
    </>
  )
}
