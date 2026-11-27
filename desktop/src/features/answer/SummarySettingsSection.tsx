import { useId, useState } from 'react'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import type { TauriApi } from '../../lib/tauri'
import { useUiStore } from '../../store/ui'
import { jevCode, jevErrorText } from './jev'
import { saveJevKey, useJevKeyStatus, useJevKeyStore } from './jevKey'

export interface SummarySettingsSectionProps {
  tauri: TauriApi
  /** Why: 입력 중인 키 — 대화상자가 들고 있어 닫으면 사라지고, [저장]도 이 값을 저장한다 */
  draft: string
  onDraftChange(draft: string): void
}

/** Why: 서버 설정은 provider 밖(서버 시작 화면)에서도 열린다 — react-query·deps 훅을 쓰지 않고 tauri 를 받는다 */
export function SummarySettingsSection({ tauri, draft, onDraftChange }: SummarySettingsSectionProps) {
  const uid = useId()
  const fid = (name: string) => `${uid}-${name}`
  const claudeReply = useUiStore((s) => s.summaryClaudeReply)
  const setClaudeReply = useUiStore((s) => s.setSummaryClaudeReply)
  const jev = useUiStore((s) => s.summaryJev)
  const setJev = useUiStore((s) => s.setSummaryJev)
  const { saved, checkFailed } = useJevKeyStatus(tauri)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<void>, failText: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(`${failText}: ${jevErrorText(jevCode(e))}`)
    } finally {
      setBusy(false)
    }
  }
  const save = () =>
    run(async () => {
      await saveJevKey(tauri, draft)
      onDraftChange('')
    }, 'Jev API 키를 저장하지 못했습니다')
  const remove = () =>
    run(async () => {
      await tauri.jevKeyDelete()
      useJevKeyStore.getState().set(false)
    }, 'Jev API 키를 지우지 못했습니다')

  const keyState = saved === true ? '저장됨' : saved === false ? '없음' : checkFailed ? '확인하지 못했습니다' : '확인 중…'

  return (
    <section className="grid gap-2" aria-labelledby={fid('summary')}>
      <h3 id={fid('summary')} className="text-sm font-semibold">
        세션 요약
      </h3>
      <p className="text-xs text-muted-foreground">답변 모드 요약 카드에 보일 것을 고릅니다. 바꾸면 바로 적용되고 이 PC 에 저장됩니다.</p>
      <div className="grid gap-1">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={claudeReply} onChange={(e) => setClaudeReply(e.target.checked)} aria-describedby={fid('claude-hint')} />
          Claude Code 마지막 답변 앞부분 보이기
        </label>
        <p id={fid('claude-hint')} className="text-xs text-muted-foreground">
          세션 기록 파일을 읽기만 합니다.
        </p>
      </div>
      <div className="grid gap-1">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={jev} onChange={(e) => setJev(e.target.checked)} aria-describedby={fid('jev-hint')} />
          Jev 판정 버튼 보이기
        </label>
        <p id={fid('jev-hint')} className="text-xs text-muted-foreground">
          누르면 그 터미널의 마지막 글자(최대 200줄)를 TypeSafe(api.typesafe.ai)로 보냅니다.
        </p>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={fid('jev-key')}>Jev API 키</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={fid('jev-key')}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            // Why: Enter 가 아래의 서버 설정 저장(서버 재시작)을 일으키지 않고 키만 저장하게 한다
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              void save()
            }}
            aria-describedby={fid('jev-key-state')}
            className="w-64"
          />
          <Button type="button" variant="outline" size="sm" aria-disabled={busy || undefined} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50" onClick={() => void save()}>
            Jev API 키 저장
          </Button>
          <Button type="button" variant="ghost" size="sm" aria-disabled={busy || undefined} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50" onClick={() => void remove()}>
            Jev API 키 지우기
          </Button>
        </div>
        <p id={fid('jev-key-state')} role="status" className="text-xs text-muted-foreground">
          키체인: {keyState}
        </p>
      </div>
      {error && (
        <p className="rounded bg-destructive/10 p-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
