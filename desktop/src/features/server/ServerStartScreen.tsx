import { Loader2Icon } from 'lucide-react'

import { Button } from '../../components/ui/button'
import type { ServerStatus, TauriApi } from '../../lib/tauri'
import { openServerSettings } from '../../store/server'

/** 앱이 서버에 붙기 전 화면 — 시작 중이면 대기, 실패·정지면 원인과 복구 수단 */
export function ServerStartScreen({ status, tauri }: { status: ServerStatus | null; tauri: TauriApi }) {
  if (!status || status.state === 'starting') {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" role="status" data-testid="server-starting">
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> 서버 시작 중…
      </div>
    )
  }
  return (
    <div className="flex h-full items-center justify-center bg-muted/40 p-4">
      <div className="grid w-full max-w-lg gap-3 rounded-lg border bg-background p-6 shadow-sm" role="alert" data-testid="server-failed">
        <h1 className="font-semibold">{status.state === 'stopped' ? '서버가 멈춰 있습니다' : '서버를 시작하지 못했습니다'}</h1>
        {status.message && <pre className="max-h-60 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{status.message}</pre>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void tauri.serverRestart()}>다시 시작</Button>
          <Button variant="outline" onClick={openServerSettings}>
            서버 설정
          </Button>
          <Button variant="ghost" onClick={() => void tauri.serverOpenLogDir()}>
            로그 폴더 열기
          </Button>
        </div>
      </div>
    </div>
  )
}
