import { useEffect, useState } from 'react'

import { Button } from '../../components/ui/button'
import type { TauriApi } from '../../lib/tauri'
import { checkForUpdate } from './update'

/** 서버 설정 대화상자의 "앱" 섹션 — 현재 버전과 [업데이트 확인] */
export function AppUpdateSection({ tauri, headingId }: { tauri: TauriApi; headingId: string }) {
  const [version, setVersion] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState('')

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

  async function check() {
    setChecking(true)
    setResult('')
    try {
      const info = await checkForUpdate(tauri, true)
      setResult(info ? `새 버전 v${info.version} 이 있습니다 — 화면 위 안내에서 설치하세요` : '최신 버전입니다')
    } catch (e) {
      setResult(`확인하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="grid gap-2" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-sm font-semibold">
        앱
      </h3>
      <div className="flex items-center gap-2">
        <span className="text-sm" data-testid="app-version">
          minmo {version ? `v${version}` : ''}
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => void check()} disabled={checking}>
          {checking ? '확인 중…' : '업데이트 확인'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {result}
      </p>
    </section>
  )
}
