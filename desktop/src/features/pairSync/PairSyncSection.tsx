import { useId, useState } from 'react'

import { createPairSyncClient } from '@minmo/api-client'

import { useDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { KEYCHAIN_KEYS } from '../../lib/tauri'
import { usePairStore } from '../../store/pairSync'
import { runPairSync, usePairSyncStatus } from './pairSync'

/** 전역 설정 — 페어링 코드로 다른 PC 와 설정을 맞춘다. 이 PC(native)에서만 쓴다 */
export function PairSyncSection() {
  const uid = useId()
  const { api, tauri } = useDeps()
  const { url, pairId, setUrl, link, unlink } = usePairStore()
  const status = usePairSyncStatus((s) => s.s)
  const [code, setCode] = useState('')
  const [issued, setIssued] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (tauri.runtime !== 'native') return null

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const syncNow = () => runPairSync({ tauri, api })

  // 새 페어를 만들고 코드를 보인다 — 다른 PC 에서 이 코드를 입력하면 연결된다
  const issue = () =>
    guard(async () => {
      const client = createPairSyncClient(url.trim())
      if (pairId) {
        const token = await tauri.keychainGet(KEYCHAIN_KEYS.pairToken)
        if (!token) throw new Error('연결 정보가 없습니다. 연결을 끊고 다시 시도하세요')
        setIssued((await client.reissueCode(pairId, token)).pairCode)
        return
      }
      const c = await client.create()
      await tauri.keychainSet(KEYCHAIN_KEYS.pairToken, c.token)
      link(url.trim(), c.pairId)
      setIssued(c.pairCode)
      void syncNow()
    })

  const join = () =>
    guard(async () => {
      const j = await createPairSyncClient(url.trim()).join(code.trim())
      await tauri.keychainSet(KEYCHAIN_KEYS.pairToken, j.token)
      link(url.trim(), j.pairId)
      setCode('')
      void syncNow()
    })

  const disconnect = () =>
    guard(async () => {
      await tauri.keychainDelete(KEYCHAIN_KEYS.pairToken)
      unlink()
      setIssued(null)
    })

  return (
    <div className="grid gap-2 rounded border p-3" data-testid="pair-sync-section">
      <div className="text-sm font-medium">설정 동기화 (페어링 코드)</div>
      <p className="text-xs text-muted-foreground">
        동기화 서버를 거쳐 다른 PC 와 메모·브랜치 이름 설정·저장소 목록을 맞춥니다. 스크립트·경로·에이전트 명령·로그인 정보는 보내지 않습니다.
      </p>
      <div className="flex items-center gap-2">
        <label htmlFor={`${uid}-url`} className="shrink-0 text-sm">
          서버 주소
        </label>
        <Input id={`${uid}-url`} value={url} placeholder="http://127.0.0.1:8788" onChange={(e) => setUrl(e.target.value)} disabled={!!pairId} spellCheck={false} className="h-7 text-sm" />
      </div>
      {pairId ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span data-testid="pair-status" role="status">
            {status.busy ? '맞추는 중…' : status.error ? `실패: ${status.error}` : status.at ? `연결됨 · 마지막 동기화 ${new Date(status.at).toLocaleTimeString()}` : '연결됨'}
          </span>
          <Button size="sm" variant="outline" onClick={() => void syncNow()} disabled={status.busy}>
            지금 맞추기
          </Button>
          <Button size="sm" variant="outline" onClick={() => void issue()} disabled={busy}>
            새 코드 만들기
          </Button>
          <Button size="sm" variant="outline" onClick={() => void disconnect()} disabled={busy}>
            연결 끊기
          </Button>
        </div>
      ) : (
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void issue()} disabled={busy || !url.trim()}>
              코드 만들기
            </Button>
            <span className="text-xs text-muted-foreground">또는</span>
            <Input aria-label="페어링 코드" value={code} placeholder="XXXXX-XXXXX" onChange={(e) => setCode(e.target.value)} spellCheck={false} className="h-7 max-w-40 text-sm" />
            <Button size="sm" variant="outline" onClick={() => void join()} disabled={busy || !url.trim() || !code.trim()}>
              연결
            </Button>
          </div>
        </div>
      )}
      {issued && (
        <p className="text-sm" data-testid="pair-code">
          페어링 코드: <code className="rounded bg-muted px-1 font-mono">{issued}</code> <span className="text-xs text-muted-foreground">(10분, 1회용)</span>
        </p>
      )}
      <p role="alert" className="text-xs text-destructive">
        {error ?? ''}
      </p>
    </div>
  )
}
