import { useEffect, useId, useState } from 'react'

import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group'
import { THEMES, THEME_LABEL } from '../../lib/theme'
import { FONT_SIZE, useUiStore } from '../../store/ui'
import type { Theme } from '../../store/ui'
import { DEFAULT_AGENT_COMMANDS, LAUNCH_KINDS, LAUNCH_LABEL, PROMPT_SLOT, buildCommand } from '../agents/launch'
import type { LaunchKind } from '../agents/launch'

export function AppearanceSection() {
  const uid = useId()
  const fid = (name: string) => `${uid}-${name}`
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const fontSize = useUiStore((s) => s.fontSize)
  const setFontSize = useUiStore((s) => s.setFontSize)
  // Why: 입력 중인 글자 — 범위 안의 숫자가 됐을 때만 적용한다("1" 을 치는 순간 9 로 바뀌지 않게)
  const [fontDraft, setFontDraft] = useState(String(fontSize))
  useEffect(() => setFontDraft(String(fontSize)), [fontSize])

  return (
    <div className="grid gap-5">
      <section className="grid gap-2" aria-labelledby={fid('theme')}>
        <h3 id={fid('theme')} className="text-sm font-semibold">
          테마
        </h3>
        <RadioGroup aria-labelledby={fid('theme')} value={theme} onValueChange={(v) => setTheme(v as Theme)} className="flex flex-wrap gap-4">
          {THEMES.map((t) => (
            <div key={t} className="flex items-center gap-2">
              <RadioGroupItem id={fid(`theme-${t}`)} value={t} />
              <Label htmlFor={fid(`theme-${t}`)}>{THEME_LABEL[t]}</Label>
            </div>
          ))}
        </RadioGroup>
        <p className="text-xs text-muted-foreground">바꾸면 바로 적용되고 이 PC 에 저장됩니다.</p>
      </section>

      <section className="grid gap-2" aria-labelledby={fid('font')}>
        <h3 id={fid('font')} className="text-sm font-semibold">
          글자 크기(터미널·파일 편집기)
        </h3>
        <div className="flex items-center gap-2">
          <Input
            id={fid('font-size')}
            aria-labelledby={fid('font')}
            type="number"
            min={FONT_SIZE.min}
            max={FONT_SIZE.max}
            step={1}
            value={fontDraft}
            onChange={(e) => {
              setFontDraft(e.target.value)
              const n = Number(e.target.value)
              if (Number.isInteger(n) && n >= FONT_SIZE.min && n <= FONT_SIZE.max) setFontSize(n)
            }}
            onBlur={() => setFontDraft(String(fontSize))}
            // Why: 값은 이미 적용돼 있어 Enter 는 입력만 끝낸다 — 감싼 폼이 있어도 제출하지 않게 한다
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              e.currentTarget.blur()
            }}
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">px</span>
          <Button type="button" variant="outline" size="sm" disabled={fontSize === FONT_SIZE.default} onClick={() => setFontSize(FONT_SIZE.default)}>
            기본값
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          바꾸면 바로 적용되고 이 PC 에 저장됩니다({FONT_SIZE.min}~{FONT_SIZE.max}px). 단축키: Ctrl + 키우기 · Ctrl - 줄이기 · Ctrl 0 기본값.
        </p>
      </section>
    </div>
  )
}

export function NotifySection() {
  const uid = useId()
  const fid = (name: string) => `${uid}-${name}`
  const agentNotify = useUiStore((s) => s.agentNotify)
  const setAgentNotify = useUiStore((s) => s.setAgentNotify)
  const showUsage = useUiStore((s) => s.showUsage)
  const setShowUsage = useUiStore((s) => s.setShowUsage)

  return (
    <div className="grid gap-5">
      <section className="grid gap-2" aria-labelledby={fid('agents')}>
        <h3 id={fid('agents')} className="text-sm font-semibold">
          에이전트 알림
        </h3>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={agentNotify} onChange={(e) => setAgentNotify(e.target.checked)} />
          에이전트가 작업을 끝내거나 입력을 기다리면 알림 띄우기
        </label>
        <p className="text-xs text-muted-foreground">그 터미널을 보고 있지 않을 때만 알립니다. 바꾸면 바로 적용되고 이 PC 에 저장됩니다.</p>
      </section>

      <section className="grid gap-2" aria-labelledby={fid('usage')}>
        <h3 id={fid('usage')} className="text-sm font-semibold">
          AI 사용량
        </h3>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showUsage} onChange={(e) => setShowUsage(e.target.checked)} />
          하단 바에 AI 별 사용량 표시
        </label>
        <p className="text-xs text-muted-foreground">
          지금 보는 호스트의 기록에서 읽습니다(읽기만 합니다). Codex 는 마지막으로 쓴 시점의 한도 사용률, Claude Code · Gemini CLI 는 오늘 쓴 토큰 수입니다. 원격 호스트는 python3 이 있어야 합니다.
        </p>
      </section>
    </div>
  )
}

export function AgentCommandsSection() {
  return (
    <div className="grid gap-4">
      <p className="text-xs text-muted-foreground">
        [에이전트 실행] 이 쓰는 명령입니다. <code>{PROMPT_SLOT}</code> 자리에 지시문이 들어갑니다. 바꾸면 바로 저장됩니다.
      </p>
      {LAUNCH_KINDS.map((kind) => (
        <AgentCommandField key={kind} kind={kind} />
      ))}
    </div>
  )
}

type CommandNote = { kind: 'error' | 'hint'; text: string }

function commandNote(template: string): CommandNote | null {
  if (template.trim() === '') return null
  if (!template.includes(PROMPT_SLOT)) return { kind: 'hint', text: `${PROMPT_SLOT} 자리가 없어 지시문 없이 실행할 때만 쓸 수 있습니다` }
  // Why: 지시문이 있다고 보고 검사한다 — 지시문에 따라 갈리는 오류(빈 명령)는 실행 대화상자가 알린다
  const built = buildCommand(template, 'x', 'posix')
  return built.ok ? null : { kind: 'error', text: built.error }
}

// Why: 칸은 자기 값을 따로 들고 trim 한 값만 저장한다 — 저장값으로 그리면 칠 때마다 끝 공백이 지워져 띄어 쓸 수 없다
function AgentCommandField({ kind }: { kind: LaunchKind }) {
  const uid = useId()
  const saved = useUiStore((s) => s.agentCommands[kind])
  const [draft, setDraft] = useState(saved)
  // Why: 밖(호스트 공유·다른 창)에서 바뀐 값은 칸에 반영하되, 입력 중인 값과 같은 뜻(앞뒤 공백 차이)이면 그대로 둔다
  const [seen, setSeen] = useState(saved)
  if (saved !== seen) {
    setSeen(saved)
    if (draft.trim() !== saved) setDraft(saved)
  }
  const note = commandNote(draft)
  const fallback = DEFAULT_AGENT_COMMANDS[kind]
  const change = (value: string) => {
    setDraft(value)
    useUiStore.getState().setAgentCommand(kind, value.trim())
  }

  return (
    <div className="grid gap-1">
      <Label htmlFor={uid}>{LAUNCH_LABEL[kind]}</Label>
      <div className="flex gap-2">
        <Input
          id={uid}
          value={draft}
          onChange={(e) => change(e.target.value)}
          spellCheck={false}
          className="font-mono"
          placeholder={kind === 'custom' ? `my-agent ${PROMPT_SLOT}` : undefined}
          aria-invalid={note?.kind === 'error' || undefined}
          aria-describedby={`${uid}-note`}
        />
        {kind !== 'custom' && (
          <Button type="button" variant="outline" aria-label={`${LAUNCH_LABEL[kind]} 기본값`} disabled={saved === fallback} onClick={() => change(fallback)}>
            기본값
          </Button>
        )}
      </div>
      {note?.kind === 'error' ? (
        <p id={`${uid}-note`} role="alert" className="text-sm text-destructive">
          {note.text}
        </p>
      ) : (
        // Why: live region 은 미리 렌더해 두어야 변화가 읽힌다
        <p id={`${uid}-note`} role="status" className="text-xs text-muted-foreground">
          {note?.text ?? ''}
        </p>
      )}
    </div>
  )
}
