import { useEffect, useId, useState } from 'react'

import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { getTauri } from '../../lib/tauri'
import type { CloseAction, TauriApi, Unlisten } from '../../lib/tauri'

/** 창 닫기(X)를 눌렀을 때 트레이로 숨길지 종료할지 묻는다 — 서버 설정의 "창을 닫을 때"가 "매번 묻기"일 때 */
export function CloseDialog({ tauri = getTauri() }: { tauri?: TauriApi }) {
  const uid = useId()
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    let alive = true
    let unlisten: Unlisten | null = null
    void tauri
      .onCloseRequested(() => alive && setOpen(true))
      .then((u) => {
        if (alive) unlisten = u
        else u()
      })
    return () => {
      alive = false
      unlisten?.()
    }
  }, [tauri])

  function choose(action: Exclude<CloseAction, 'ask'>) {
    setOpen(false)
    setRemember(false)
    void tauri.appClose(action, remember).catch(() => undefined)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>창을 닫을까요?</DialogTitle>
          <DialogDescription>트레이로 최소화하면 서버가 계속 실행되어 원격 CLI 를 쓸 수 있습니다. 종료하면 서버도 함께 멈춥니다.</DialogDescription>
        </DialogHeader>
        <label htmlFor={`${uid}-remember`} className="flex items-center gap-2 text-sm">
          <input id={`${uid}-remember`} type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          다음부터 묻지 않기 (서버 설정에서 바꿀 수 있습니다)
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            취소
          </Button>
          <Button variant="outline" onClick={() => choose('quit')}>
            종료
          </Button>
          <Button onClick={() => choose('tray')}>트레이로 최소화</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
