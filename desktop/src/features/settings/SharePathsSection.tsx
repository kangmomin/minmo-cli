import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'

import { useDeps } from '../../app/deps'
import { queryKeys } from '../../lib/queryKeys'
import { useServerStore } from '../../store/server'

/** 전역 설정 — 작업 폴더 경로·생성 후 스크립트를 같은 계정의 다른 PC 와 함께 쓸지 정한다. 이 PC(native)에서만 쓴다.
 *  끄면(기본) 그 값들을 이 PC 에만 저장한다 — PC 마다 폴더와 명령이 달라서다. 브랜치 이름 설정·메모는 언제나 함께 쓴다 */
export function SharePathsSection() {
  const uid = useId()
  const { tauri } = useDeps()
  const queryClient = useQueryClient()
  const setPcId = useServerStore((s) => s.setPcId)
  const [share, setShare] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const native = tauri.runtime === 'native'

  useEffect(() => {
    if (!native) return
    let alive = true
    tauri
      .serverSettingsGet()
      .then((s) => alive && setShare(s.sharePaths ?? false))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [tauri, native])

  if (!native) return null

  async function onChange(next: boolean) {
    setBusy(true)
    setError(null)
    try {
      const saved = await tauri.serverSettingsSave({ sharePaths: next })
      setShare(saved.sharePaths ?? false)
      // 이후 요청부터 PC 식별자를 붙이거나 뗀다 — 열려 있는 설정·경로 미리보기는 새 기준으로 다시 읽는다
      setPcId(saved.pcId ?? null)
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['settings'] }), queryClient.invalidateQueries({ queryKey: queryKeys.effectiveAll })])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-2 rounded border p-3" data-testid="share-paths-section">
      <label htmlFor={`${uid}-share`} className="flex items-center gap-2 text-sm font-medium">
        <input id={`${uid}-share`} type="checkbox" checked={share ?? false} disabled={share === null || busy} onChange={(e) => void onChange(e.target.checked)} />
        경로·스크립트를 다른 PC 와 공유
      </label>
      <p className="text-xs text-muted-foreground">
        끄면 작업 폴더 경로·메인 clone 경로·생성 후 스크립트·무시된 파일 가져오기를 이 PC 에만 저장합니다(전역·조직·저장소 설정 모두). 켜면 같은 계정의 다른 PC 와 같은 값을
        씁니다. 브랜치 이름 설정과 메모는 언제나 함께 씁니다.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          저장하지 못했습니다: {error}
        </p>
      )}
    </div>
  )
}
