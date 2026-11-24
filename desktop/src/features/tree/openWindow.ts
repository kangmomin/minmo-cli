import { useBaseDeps } from '../../app/deps'
import type { TauriApi } from '../../lib/tauri'
import { encodeScope } from '../../lib/windowScope'
import type { WindowScope } from '../../lib/windowScope'
import { useSessionStore } from '../../store/session'

export type OpenWindow = (scope: WindowScope | null, title: string | null) => void

/** 같은 앱 화면을 새 창으로 연다(#105). 실패하면 상단 안내로 알린다 */
export function openWindow(tauri: Pick<TauriApi, 'windowOpen'>, scope: WindowScope | null, title: string | null) {
  void tauri.windowOpen(scope ? encodeScope(scope) : null, title).catch((e: unknown) => {
    useSessionStore.getState().setNotice(`새 창을 열 수 없습니다 — ${e instanceof Error ? e.message : String(e)}`)
  })
}

/** 새 창 열기. 원격으로 붙은 화면(브라우저)에서는 null — 그 PC 의 앱 안에서만 창을 띄운다 */
export function useOpenWindow(): OpenWindow | null {
  // 이슈의 호스트(HostScope)가 아니라 이 PC 의 앱에서 연다
  const { tauri } = useBaseDeps()
  if (tauri.runtime === 'remote') return null
  return (scope, title) => openWindow(tauri, scope, title)
}
