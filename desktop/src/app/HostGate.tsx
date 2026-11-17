// 연결을 확인한 호스트에서만 내용을 보인다. HostScope 는 연결 기록이 없는 원격을 "이 PC" 로 바꾸므로,
// 그대로 쓰면 원격의 이슈가 이 PC 에서 열릴 수 있다 — 그 대신 연결 상태를 보이고 연결되면 내용을 보인다.
import type { ReactNode } from 'react'

import { Button } from '../components/ui/button'
import { sshErrorText } from '../lib/sshHost'
import { HostScope, useHostStatus } from './host'
import type { HostStatus } from './host'

export function HostStatusNotice({
  alias,
  status,
  children,
  className = 'grid gap-2 p-3 text-sm',
  testId = 'host-unavailable',
}: {
  alias: string
  status: Pick<HostStatus, 'connecting' | 'error' | 'connect'>
  /** 버튼 줄에 더할 동작 */
  children?: ReactNode
  className?: string
  testId?: string
}) {
  return (
    <div className={className} data-testid={testId}>
      {status.error ? (
        <p role="alert" className="rounded bg-destructive/10 p-2 text-destructive">
          {sshErrorText(alias, status.error)}
        </p>
      ) : (
        <p role="status" className="text-muted-foreground">
          {alias} 에 연결하는 중…
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {/* 처음 접속하는 호스트: 사용자가 고르면 호스트 키를 등록하고 연결한다 */}
        {status.error?.kind === 'host_key' && (
          <Button size="sm" variant="outline" disabled={status.connecting} onClick={() => void status.connect(true)}>
            호스트 키 등록하고 연결
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={status.connecting} onClick={() => void status.connect()}>
          다시 시도
        </Button>
        {children}
      </div>
    </div>
  )
}

export interface HostGateProps {
  /** null = 이 PC(항상 준비됨) */
  alias: string | null
  children: ReactNode
  /** 연결 전·실패 때 보일 내용(없으면 HostStatusNotice) */
  pending?(status: HostStatus): ReactNode
}

export function HostGate({ alias, children, pending }: HostGateProps) {
  const status = useHostStatus(alias)
  if (status.ready || alias === null) return <HostScope alias={alias}>{children}</HostScope>
  return <>{pending ? pending(status) : <HostStatusNotice alias={alias} status={status} />}</>
}
