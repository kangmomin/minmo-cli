import { useState } from 'react'
import type { ReactNode } from 'react'

import { useBaseDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import type { TauriApi } from '../../lib/tauri'
import { useUiStore } from '../../store/ui'
import { rowKey } from '../agents/overview'
import type { AgentRow } from '../agents/overview'
import { readTerminalText } from '../terminal/terminalText'
import { JEV_MAX_LINES, buildJevRequest, jevCode, jevErrorText, parseJevResponse } from './jev'
import type { JevVerdict as Verdict } from './jev'
import { useJevKeyStatus, useJevKeyStore } from './jevKey'

const NEED_LABEL: Record<string, string> = { permission: '권한 허용', question: '질문에 답', next_task: '다음 작업 지시', error: '오류 확인', none: '없음' }
const OUTCOME_LABEL: Record<string, string> = { success: '성공', partial: '일부 끝남', failed: '실패', unknown: '알 수 없음' }
const URGENCY_LABEL = ['낮음', '보통', '높음']

/** Why: key = 판정을 묶는 세션·기다림, token = 그 누름 */
type Result = { key: string; token: number } & ({ kind: 'busy' } | { kind: 'empty' } | { kind: 'done'; verdict: Verdict | null } | { kind: 'error'; message: string })

let nextToken = 0

export function JevVerdict({ row }: { row: AgentRow | null }) {
  const on = useUiStore((s) => s.summaryJev)
  const { tauri } = useBaseDeps()
  // Why: 키는 이 PC 키체인에 있고 보내는 글자는 이 PC 화면의 터미널 글자다 — 원격 화면(브라우저·휴대폰)에는 두지 않는다
  if (!on || tauri.runtime === 'remote' || !row) return null
  return <VerdictBox row={row} tauri={tauri} />
}

function VerdictBox({ row, tauri }: { row: AgentRow; tauri: TauriApi }) {
  const { saved, checkFailed } = useJevKeyStatus(tauri)

  // Why: 판정은 그 세션의 그 기다림에 묶는다 — 세션이 바뀌거나 다시 기다리는 상태가 되면 지운다
  const key = `${rowKey(row)}\n${row.waitingSince}`
  const [result, setResult] = useState<Result | null>(null)
  // Why: 렌더 중에 지워야 응답 전에 세션이 바뀐 판정이 그 세션으로 돌아왔을 때 다시 보이지 않는다(늦은 응답은 token 이 달라 버린다)
  if (result !== null && result.key !== key) setResult(null)
  const shown = result?.key === key ? result : null
  const busy = shown?.kind === 'busy'

  async function decide() {
    if (busy) return
    const token = ++nextToken
    const text = readTerminalText(row.paneId, JEV_MAX_LINES)
    if (text.trim() === '') {
      setResult({ key, token, kind: 'empty' })
      return
    }
    setResult({ key, token, kind: 'busy' })
    const settle = (next: Result | null) => setResult((r) => (r?.token === token ? next : r))
    try {
      const raw = await tauri.jevDecide(buildJevRequest(text))
      settle({ key, token, kind: 'done', verdict: parseJevResponse(raw) })
    } catch (e) {
      const code = jevCode(e)
      if (code !== 'jev_key_missing') {
        settle({ key, token, kind: 'error', message: jevErrorText(code) })
        return
      }
      // Why: 키가 없어졌다 — 버튼 대신 키 안내를 보인다
      settle(null)
      useJevKeyStore.getState().set(false)
    }
  }

  let status: ReactNode = null
  if (saved === false) status = jevErrorText('jev_key_missing')
  else if (busy) status = 'Jev 판정 중…'
  else if (shown?.kind === 'empty') status = '보낼 글자가 없습니다'
  else if (shown?.kind === 'done') status = shown.verdict ? <Chips verdict={shown.verdict} /> : '판정 없음'

  return (
    <div data-testid="jev-verdict" className="grid min-w-0 gap-1 text-xs">
      {saved !== false && (saved !== null || checkFailed) && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-disabled={busy || undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={() => void decide()}
          >
            Jev 판정
          </Button>
        </div>
      )}
      <div role="status" className="flex min-w-0 flex-wrap items-center gap-1">
        {status}
      </div>
      {shown?.kind === 'error' && (
        <p role="alert" className="text-destructive">
          {shown.message}
        </p>
      )}
    </div>
  )
}

const percent = (p: number) => `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`

function Chip({ name, value, probability }: { name: string; value: string | undefined; probability: number | undefined }) {
  return (
    <span className="rounded border px-1.5 py-0.5">
      {name}: {value ?? '판정 없음'}
      {probability !== undefined && <span className="ml-1 text-muted-foreground">{percent(probability)}</span>}
    </span>
  )
}

function Chips({ verdict: { need, outcome, urgency } }: { verdict: Verdict }) {
  return (
    <>
      <Chip name="필요한 것" value={need ? NEED_LABEL[need.choice] : undefined} probability={need?.probability} />
      <Chip name="결과" value={outcome ? OUTCOME_LABEL[outcome.choice] : undefined} probability={outcome?.probability} />
      <Chip name="급함" value={urgency ? URGENCY_LABEL[urgency.level] : undefined} probability={urgency?.probability} />
    </>
  )
}
