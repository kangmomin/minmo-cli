import { DownloadIcon } from 'lucide-react'
import { useEffect } from 'react'

import { Button } from '../../components/ui/button'
import { getTauri } from '../../lib/tauri'
import type { TauriApi } from '../../lib/tauri'
import { useUpdateStore } from '../../store/update'
import { checkForUpdate, installUpdate, progressPercent } from './update'

/** 앱이 뜬 뒤 이만큼 기다렸다가 확인한다(시작 작업과 겹치지 않게) */
export const UPDATE_CHECK_DELAY_MS = 5_000
/** 트레이로 오래 떠 있는 앱도 새 버전을 알도록 다시 확인하는 주기 */
export const UPDATE_RECHECK_MS = 12 * 60 * 60 * 1000

/** 새 버전 안내 띠 — [설치하고 다시 시작] / [나중에] */
export function UpdateNotice({ tauri = getTauri() }: { tauri?: TauriApi }) {
  const { available, dismissed, installing, progress, error, set } = useUpdateStore()

  useEffect(() => {
    const first = setTimeout(() => void checkForUpdate(tauri), UPDATE_CHECK_DELAY_MS)
    const again = setInterval(() => {
      // 설치 중에는 상태를 바꾸지 않는다
      if (!useUpdateStore.getState().installing) void checkForUpdate(tauri)
    }, UPDATE_RECHECK_MS)
    return () => {
      clearTimeout(first)
      clearInterval(again)
    }
  }, [tauri])

  const visible = available !== null && (dismissed !== available.version || installing || error !== null)
  const pct = progressPercent(progress)

  // live region 은 내용이 바뀌기 전부터 있어야 스크린 리더가 읽는다
  return (
    <div role="status">
      {visible && available && (
        <div data-testid="update-notice" className="flex items-center gap-3 border-b bg-primary/10 px-4 py-1.5 text-sm">
          <DownloadIcon className="size-4" aria-hidden="true" />
          {error ? (
            <span className="flex-1 text-destructive">업데이트하지 못했습니다 — {error}</span>
          ) : installing ? (
            <span className="flex-1">
              v{available.version} 받는 중{pct === null ? '…' : ` ${pct}%`} — 설치가 끝나면 앱이 다시 시작됩니다
            </span>
          ) : (
            <span className="flex-1">
              새 버전 v{available.version} 이 있습니다(현재 v{available.currentVersion}). 설치하면 앱과 서버가 다시 시작되고 열린 터미널은 닫힙니다.
            </span>
          )}
          {!installing && (
            <>
              <Button size="sm" onClick={() => void installUpdate(tauri)}>
                {error ? '다시 시도' : '설치하고 다시 시작'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => set({ dismissed: available.version, error: null })}>
                나중에
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
