import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group'
import { useHostsStore, workHostAliasOf } from '../../store/hosts'
import { repoKey, useRepoShortName } from '../../store/repos'
import { useUiStore } from '../../store/ui'
import { LAUNCH_KINDS, LAUNCH_LABEL, buildCommand } from '../agents/launch'
import type { LaunchKind } from '../agents/launch'
import { TAKER_MAX_ACTIVE, isActive, riskyFlags, validateSteps } from './taker'
import { defaultTakerConfig, useTakerStore } from './takerStore'
import type { TakerAuthor, TakerCheck, TakerRun, TakerStatus, TakerStep } from './takerStore'
import { useTakerActions } from './useIssueTaker'
import type { TakerActions } from './useIssueTaker'

export const TAKER_STATUS_LABEL: Record<TakerStatus, string> = {
  queued: '대기',
  preparing: '준비 중',
  running: '실행 중',
  manualNext: '다음 단계 대기',
  done: '끝남',
  stopped: '멈춤',
  failed: '실패',
  interrupted: '중단됨',
}

const AUTHOR_OPTIONS: readonly [TakerAuthor, string][] = [
  ['me', '내가 쓴 이슈만'],
  ['writers', '쓰기 권한자'],
  ['anyone', '제한 없음'],
]

export interface IssueTakerDialogProps {
  owner: string
  repo: string
  open: boolean
  onOpenChange(open: boolean): void
}

export function IssueTakerDialog({ owner, repo, open, onOpenChange }: IssueTakerDialogProps) {
  const name = useRepoShortName(owner, repo)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>이슈 테이커 — {name}</DialogTitle>
          <DialogDescription>
            켜 두면 새로 열린 이슈마다 이 PC 의 minmo 가 화면을 바꾸지 않고 worktree 를 열어 아래 단계를 차례로 실행합니다. 설정과 실행 기록은 이 PC 에만 저장됩니다.
          </DialogDescription>
        </DialogHeader>
        {open && <TakerBody owner={owner} repo={repo} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

type DraftStep = TakerStep & { id: number }
type StepPart = 'kind' | 'up' | 'down'

function TakerBody({ owner, repo, onDone }: { owner: string; repo: string; onDone(): void }) {
  const uid = useId()
  const key = repoKey(owner, repo)
  const actions = useTakerActions()
  const [initial] = useState(() => useTakerStore.getState().repos[key] ?? defaultTakerConfig())
  const [enabled, setEnabled] = useState(initial.enabled)
  const [author, setAuthor] = useState<TakerAuthor>(initial.author)
  const [catchUp, setCatchUp] = useState(initial.catchUp)
  const [steps, setSteps] = useState<DraftStep[]>(() => initial.steps.map((s, i) => ({ ...s, id: i })))
  const [announce, setAnnounce] = useState('')
  const pendingFocus = useRef<string | null>(null)
  const alias = useHostsStore((s) => workHostAliasOf(s, owner, repo))
  const noTmux = useHostsStore((s) => alias !== null && (!s.useTmux || s.probes[alias]?.tmux === false))
  const allRuns = useTakerStore((s) => s.runs)
  const check = useTakerStore((s) => s.lastCheck[key])

  useEffect(() => {
    if (pendingFocus.current === null) return
    document.getElementById(pendingFocus.current)?.focus()
    pendingFocus.current = null
  })

  const stepId = (id: number, part: StepPart) => `${uid}-step-${id}-${part}`
  const addId = `${uid}-add`
  const reasonId = `${uid}-reason`
  const checked = validateSteps(steps)
  const canSave = checked.error === null && checked.steps.every((e) => e === null)
  const runs = allRuns.filter((r) => r.repoKey === key).sort((a, b) => b.foundAt - a.foundAt)
  const activeCount = allRuns.filter(isActive).length

  function update(i: number, patch: Partial<TakerStep>) {
    setSteps(steps.map((s, k) => (k === i ? { ...s, ...patch } : s)))
  }

  function add() {
    const id = steps.reduce((m, s) => Math.max(m, s.id), -1) + 1
    setSteps([...steps, { id, kind: 'claude', command: useUiStore.getState().agentCommands.claude, prompt: '' }])
    pendingFocus.current = stepId(id, 'kind')
  }

  function remove(i: number) {
    const next = steps.filter((_, k) => k !== i)
    setSteps(next)
    const neighbor = next[i] ?? next[i - 1]
    pendingFocus.current = neighbor ? stepId(neighbor.id, 'kind') : addId
    setAnnounce(`${i + 1}단계를 지웠습니다 — 남은 단계 ${next.length}개`)
  }

  function move(i: number, d: -1 | 1) {
    const j = i + d
    const next = [...steps]
    ;[next[i], next[j]] = [next[j], next[i]]
    setSteps(next)
    // Why: 끝으로 옮기면 같은 방향 버튼이 비활성이 되어 포커스를 잃으므로 반대 버튼으로 둔다
    const part: StepPart = d < 0 ? (j === 0 ? 'down' : 'up') : j === next.length - 1 ? 'up' : 'down'
    pendingFocus.current = stepId(steps[i].id, part)
    setAnnounce(`${i + 1}단계를 ${j + 1}단계로 옮겼습니다`)
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSave) return
    const store = useTakerStore.getState()
    store.saveConfig(key, {
      enabled,
      author,
      catchUp,
      steps: steps.map(({ kind, command, prompt }) => ({ kind, command, prompt })),
      baseline: store.repos[key]?.baseline ?? null,
      owner,
      repo,
    })
    onDone()
  }

  function nextStep(run: TakerRun) {
    if (actions?.nextStep(run.id) === 'notReady') setAnnounce('연결을 기다리는 중 — 잠시 뒤 다시 누르세요')
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <div className="flex items-start gap-2">
        <input
          id={`${uid}-enabled`}
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          aria-describedby={`${uid}-enabled-hint`}
        />
        <div className="grid gap-0.5">
          <Label htmlFor={`${uid}-enabled`}>켜기</Label>
          <p id={`${uid}-enabled-hint`} className="text-xs text-muted-foreground">
            켠 뒤에 새로 열린 이슈를 5분마다 확인합니다. 켤 때 이미 열려 있던 이슈는 실행하지 않습니다.
          </p>
        </div>
      </div>

      <div className="grid gap-1.5">
        <span id={`${uid}-author`} className="text-sm font-medium">
          작성자
        </span>
        <RadioGroup aria-labelledby={`${uid}-author`} value={author} onValueChange={(v) => setAuthor(v as TakerAuthor)} className="flex flex-wrap gap-4">
          {AUTHOR_OPTIONS.map(([value, label]) => (
            <div key={value} className="flex items-center gap-2">
              <RadioGroupItem id={`${uid}-author-${value}`} value={value} />
              <Label htmlFor={`${uid}-author-${value}`}>{label}</Label>
            </div>
          ))}
        </RadioGroup>
      </div>

      <div className="flex items-start gap-2">
        <input
          id={`${uid}-catchup`}
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={catchUp}
          onChange={(e) => setCatchUp(e.target.checked)}
          aria-describedby={`${uid}-catchup-hint`}
        />
        <div className="grid gap-0.5">
          <Label htmlFor={`${uid}-catchup`}>앱이 꺼진 동안 열린 이슈도 실행</Label>
          <p id={`${uid}-catchup-hint`} className="text-xs text-muted-foreground">
            끄면 앱을 다시 켠 뒤 첫 확인에서 그동안 열린 이슈를 건너뜁니다.
          </p>
        </div>
      </div>

      <section aria-labelledby={`${uid}-steps`} className="grid gap-2">
        <h3 id={`${uid}-steps`} className="text-sm font-medium">
          단계
        </h3>
        <p className="text-xs text-muted-foreground">
          명령의 {'{prompt}'} 자리에 지시문이 들어갑니다. 지시문의 {'{issue}'}·{'{number}'}·{'{title}'}·{'{url}'} 는 그 이슈의 값으로 바뀝니다.
        </p>
        {steps.map((s, i) => {
          const error = checked.steps[i] ?? null
          const commandBad = error !== null && !buildCommand(s.command, s.prompt, 'posix').ok
          const promptBad = error !== null && !commandBad
          const risky = riskyFlags(s.command)
          const base = `${uid}-step-${s.id}`
          const commandDescribedBy = [risky.length > 0 && `${base}-risk`, commandBad && `${base}-error`].filter(Boolean).join(' ')
          return (
            <fieldset key={s.id} className="grid gap-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{i + 1}단계</legend>
              <div className="flex items-center gap-2">
                <select
                  id={stepId(s.id, 'kind')}
                  aria-label="에이전트"
                  className="h-8 rounded border bg-background px-2 text-sm"
                  value={s.kind}
                  onChange={(e) => {
                    const kind = e.target.value as LaunchKind
                    update(i, { kind, command: useUiStore.getState().agentCommands[kind] })
                  }}
                >
                  {LAUNCH_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {LAUNCH_LABEL[k]}
                    </option>
                  ))}
                </select>
                <div className="ml-auto flex gap-1">
                  <Button type="button" size="sm" variant="ghost" id={stepId(s.id, 'up')} aria-label={`${i + 1}단계 위로`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <span aria-hidden="true">↑</span>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    id={stepId(s.id, 'down')}
                    aria-label={`${i + 1}단계 아래로`}
                    disabled={i === steps.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <span aria-hidden="true">↓</span>
                  </Button>
                  <Button type="button" size="sm" variant="ghost" aria-label={`${i + 1}단계 삭제`} onClick={() => remove(i)}>
                    <span aria-hidden="true">삭제</span>
                  </Button>
                </div>
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`${base}-command`}>명령</Label>
                <Input
                  id={`${base}-command`}
                  value={s.command}
                  onChange={(e) => update(i, { command: e.target.value })}
                  aria-invalid={commandBad ? true : undefined}
                  aria-describedby={commandDescribedBy || undefined}
                  spellCheck={false}
                  className="font-mono"
                />
                {risky.length > 0 && (
                  <p id={`${base}-risk`} className="text-xs text-amber-700 dark:text-amber-400">
                    사람 확인 없이 명령을 실행합니다 ({risky.join(', ')})
                  </p>
                )}
                {commandBad && (
                  <p id={`${base}-error`} role="alert" className="text-xs text-destructive">
                    {error}
                  </p>
                )}
              </div>
              <div className="grid gap-1">
                <Label htmlFor={`${base}-prompt`}>지시문</Label>
                <Input
                  id={`${base}-prompt`}
                  value={s.prompt}
                  onChange={(e) => update(i, { prompt: e.target.value })}
                  aria-invalid={promptBad ? true : undefined}
                  aria-describedby={promptBad ? `${base}-prompt-error` : undefined}
                  spellCheck={false}
                />
                {promptBad && (
                  <p id={`${base}-prompt-error`} role="alert" className="text-xs text-destructive">
                    {error}
                  </p>
                )}
              </div>
            </fieldset>
          )
        })}
        <div>
          <Button type="button" size="sm" variant="outline" id={addId} onClick={add}>
            <span aria-hidden="true">+</span> 단계 추가
          </Button>
        </div>
        <p role="status" className="sr-only">
          {announce}
        </p>
      </section>

      <ul className="grid list-disc gap-1 pl-5 text-xs text-muted-foreground">
        {noTmux && (
          <li>연결 호스트가 tmux 를 쓰지 않는 원격이라 1단계만 자동으로 실행합니다. 끝났는지 알 수 없으므로 그다음은 머리줄이나 아래 실행 목록의 [다음 단계] 로 진행하세요.</li>
        )}
        <li>에이전트를 /exit·Ctrl+C 로 끝내도 그 단계가 끝난 것으로 보고 다음 단계를 시작합니다. 막으려면 먼저 [멈춤] 을 누르세요.</li>
        <li>셸 프로필이 띄운 백그라운드 작업이나 에이전트가 띄운 개발 서버가 남으면 명령이 들어가지 않거나 다음 단계로 넘어가지 않습니다. 이슈 머리줄의 [자동 실행 멈춤] 으로 푸세요.</li>
        <li>--continue 는 그 worktree 폴더의 마지막 대화를 잇습니다. 그 폴더에서 다른 Claude 대화를 시작했다면 그 대화를 잇습니다.</li>
        <li>같은 계정의 다른 PC 에서도 켜 두면 두 PC 가 모두 같은 이슈를 실행할 수 있고, 자동 실행한 패널·제목이 다른 기기에도 보입니다.</li>
        <li>주 창을 새로 고치면 진행 중이던 실행은 중단됨이 되고, 돌던 에이전트는 터미널에 남아 있을 수 있습니다.</li>
      </ul>

      <section aria-labelledby={`${uid}-runs`} className="grid gap-2">
        <h3 id={`${uid}-runs`} className="text-sm font-medium">
          {`실행 중 ${activeCount}/${TAKER_MAX_ACTIVE}`}
          <span className="ml-2 text-xs font-normal text-muted-foreground">모든 저장소 합계</span>
        </h3>
        {runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">아직 자동 실행한 이슈가 없습니다</p>
        ) : (
          <ul className="grid gap-1">
            {runs.map((r) => (
              <RunItem key={r.id} run={r} actions={actions} onNextStep={() => nextStep(r)} />
            ))}
          </ul>
        )}
        <LastCheck check={check} />
      </section>

      <DialogFooter className="items-center">
        {!canSave && (
          <p id={reasonId} className="text-xs text-destructive sm:mr-auto">
            {checked.error ?? '단계의 오류를 고치면 저장할 수 있습니다'}
          </p>
        )}
        <Button type="button" variant="ghost" onClick={onDone}>
          취소
        </Button>
        <Button type="submit" disabled={!canSave} aria-describedby={canSave ? undefined : reasonId}>
          저장
        </Button>
      </DialogFooter>
    </form>
  )
}

function RunItem({ run, actions, onNextStep }: { run: TakerRun; actions: TakerActions | null; onNextStep(): void }) {
  const n = run.number
  const stop = run.status === 'queued' || isActive(run)
  const retryLabel = run.status === 'failed' ? '다시 시도' : run.status === 'interrupted' || run.status === 'stopped' || run.status === 'manualNext' ? '이 단계부터 다시' : null
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="min-w-0 truncate">
        #{n} {run.title}
      </span>
      <span className="text-xs text-muted-foreground">{`${run.step + 1}/${run.steps.length} 단계`}</span>
      <span className="text-xs">{TAKER_STATUS_LABEL[run.status]}</span>
      {run.error && <span className="text-xs text-destructive">{run.error}</span>}
      {run.note && <span className="text-xs text-muted-foreground">{run.note}</span>}
      {actions && (
        <span className="ml-auto flex gap-1">
          {run.status === 'manualNext' && (
            <Button type="button" size="sm" variant="outline" aria-label={`#${n} 다음 단계`} onClick={onNextStep}>
              다음 단계
            </Button>
          )}
          {stop && (
            <Button type="button" size="sm" variant="ghost" aria-label={`#${n} 멈춤`} onClick={() => actions.stop(run.id)}>
              멈춤
            </Button>
          )}
          {retryLabel && (
            <Button type="button" size="sm" variant="ghost" aria-label={`#${n} ${retryLabel}`} onClick={() => actions.restart(run.id)}>
              {retryLabel}
            </Button>
          )}
        </span>
      )}
    </li>
  )
}

function LastCheck({ check }: { check: TakerCheck | undefined }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  if (check === undefined) return <p className="text-xs text-muted-foreground">마지막 확인: 아직 없음</p>
  if (check.error !== null) return <p className="text-xs text-destructive">마지막 확인 실패: {check.error}</p>
  const minutes = Math.floor((Math.max(now, check.at) - check.at) / 60_000)
  return <p className="text-xs text-muted-foreground">마지막 확인: {minutes < 1 ? '방금' : `${minutes}분 전`}</p>
}
