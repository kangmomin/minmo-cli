// 앱 업데이트 확인·설치 — 안내 띠(UpdateNotice)와 서버 설정의 [업데이트 확인]이 같은 상태(store/update)를 쓴다.
import type { TauriApi, UpdateInfo } from '../../lib/tauri'
import { useUpdateStore } from '../../store/update'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 새 버전을 확인한다. 자동 확인(manual=false)은 실패해도 조용히 넘긴다 */
export async function checkForUpdate(tauri: TauriApi, manual = false): Promise<UpdateInfo | null> {
  try {
    const info = await tauri.appUpdateCheck()
    useUpdateStore.getState().set(manual ? { available: info, dismissed: null, error: null } : { available: info })
    return info
  } catch (e) {
    if (manual) throw new Error(message(e))
    return null
  }
}

/** 받아서 설치한다 — 성공하면 앱이 다시 시작되어 돌아오지 않는다 */
export async function installUpdate(tauri: TauriApi): Promise<void> {
  const store = useUpdateStore.getState()
  store.set({ installing: true, error: null, progress: null })
  const unlisten = await tauri.onUpdateProgress((progress) => useUpdateStore.getState().set({ progress })).catch(() => null)
  try {
    await tauri.appUpdateInstall()
  } catch (e) {
    useUpdateStore.getState().set({ error: message(e) })
  } finally {
    unlisten?.()
    useUpdateStore.getState().set({ installing: false })
  }
}

export function progressPercent(p: { downloaded: number; total: number | null } | null): number | null {
  if (!p || !p.total) return null
  return Math.min(100, Math.round((p.downloaded / p.total) * 100))
}
