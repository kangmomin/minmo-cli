import { useEffect, useState } from 'react'

import { useDeps } from '../../app/deps'
import { openServerSettings } from '../../store/server'

/** 앱 버전 — 항상 보이는 자리에 두고, 누르면 업데이트 확인이 있는 서버 설정을 연다 */
export function AppVersion() {
  const { tauri } = useDeps()
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    tauri
      .appVersion()
      .then((v) => alive && setVersion(v))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [tauri])

  // 버전을 알 수 없으면(조회 실패) 자리를 차지하지 않는다
  if (!version) return null
  return (
    <button
      type="button"
      data-testid="app-version-badge"
      aria-label={`버전 ${version} — 업데이트 확인 열기`}
      title="버전 — 누르면 업데이트를 확인할 수 있는 설정을 엽니다"
      onClick={openServerSettings}
      className="rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      v{version}
    </button>
  )
}
