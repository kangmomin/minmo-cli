// E2E 큐 — 작업 목록(상태·다음 단계·취소·다시 실행·패널로 이동)과 역할 설정(CLI·모델·지시문)
import { RefreshCwIcon } from 'lucide-react'
import { useId, useState } from 'react'

import { useHost } from '../../app/host'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { Textarea } from '../../components/ui/textarea'
import { useUiStore } from '../../store/ui'
import { LAUNCH_LABEL } from '../agents/launch'
import { goToPane } from '../agents/navigate'
import { isActive, useE2eQueueStore } from './queueStore'
import type { E2eJob, JobNotice } from './queueStore'
import { DEFAULT_ROLES, E2E_ROLES, MODEL_RE, ROLE_KINDS, ROLE_LABEL } from './roles'
import type { E2eRole, RoleKind } from './roles'
import { useAgentModels } from './useAgentModels'

export interface E2eQueueDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
}

export function E2eQueueDialog({ open, onOpenChange }: E2eQueueDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>E2E 큐</DialogTitle>
          <DialogDescription>
            큐에 넣은 이슈마다 ① E2E 실행 → ② 엣지케이스 찾기 → ③ 엣지케이스 기반 테스트를 차례로 그 이슈의 새 터미널 패널에서 실행합니다. 한 번에 한 작업만 실행합니다.
          </DialogDescription>
        </DialogHeader>
        {open && <QueueBody onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function QueueBody({ onDone }: { onDone(): void }) {
  return (
    <Tabs defaultValue="jobs">
      <TabsList>
        <TabsTrigger value="jobs">작업</TabsTrigger>
        <TabsTrigger value="roles">역할 설정</TabsTrigger>
      </TabsList>
      <TabsContent value="jobs">
        <JobList onDone={onDone} />
      </TabsContent>
      <TabsContent value="roles">
        <RoleSettings />
      </TabsContent>
    </Tabs>
  )
}

const NOTICE_TEXT: Record<JobNotice, string> = {
  attention: '확인 필요 — 패널을 보세요',
  exited: '에이전트가 종료됨 — 결과를 보고 [다음 단계]로 넘기세요',
  undetected: '상태 감지 불가 — 결과 파일 기준',
  unknown: '에이전트 상태를 확인할 수 없음 — 패널을 보세요(ssh 인증 등)',
}

function statusText(j: E2eJob): string {
  switch (j.status) {
    case 'queued':
      return '대기'
    case 'running':
      return `실행 중 ${j.stage + 1}/3 ${ROLE_LABEL[E2E_ROLES[j.stage]]}${j.waitingHost ? ' · 원격 호스트 연결 대기' : ''}`
    case 'done':
      return '완료'
    case 'failed':
      return `실패 — ${j.error ?? '알 수 없는 오류'}`
    case 'cancelled':
      return '취소'
  }
}

/** [패널로 이동] 할 곳 — 실행 중이면 지금 단계, 끝났으면 마지막으로 연 단계(끝난 패널은 남겨 둔다 D-7) */
function lastPane(j: E2eJob): string | null {
  if (j.status === 'running') return j.panes[j.stage]
  return [...j.panes].reverse().find((p) => p !== null) ?? null
}

function JobList({ onDone }: { onDone(): void }) {
  const jobs = useE2eQueueStore((s) => s.jobs)
  // 단계 패널은 터미널 탭에서 뜬다 — 이슈를 하나도 열지 않았으면 터미널 탭이 없어 단계가 시작되지 않는다(A-10)
  const noIssue = useUiStore((s) => s.selectedIssueId === null)
  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        단계는 결과 파일(<code>.minmo/e2e/…</code>)이 생기고 에이전트가 쉬면 다음으로 넘어갑니다. 단계 패널은 터미널 탭에서 열리므로 이슈 화면을 하나 열어 두세요 — 110초 안에 터미널이
        뜨지 않으면 작업이 실패합니다.
      </p>
      {noIssue && (
        <p className="rounded border border-amber-500 px-2 py-1 text-sm text-amber-700 dark:text-amber-400" data-testid="e2e-no-issue">
          열어 둔 이슈가 없습니다. 이슈를 하나 고르지 않으면 단계가 시작되지 않습니다.
        </p>
      )}
      <div aria-live="polite" className="max-h-[50vh] overflow-y-auto">
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">큐가 비어 있습니다. 이슈 화면의 [E2E 큐에 추가]로 넣으세요.</p>
        ) : (
          <ul aria-label="E2E 큐 작업" className="grid gap-1">
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} onDone={onDone} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function JobRow({ job, onDone }: { job: E2eJob; onDone(): void }) {
  const q = useE2eQueueStore.getState
  const pane = lastPane(job)
  const active = isActive(job)
  // 버튼 이름에 이슈를 넣어 여러 작업 사이에서도 무엇을 누르는지 알 수 있게 한다
  const named = (action: string) => `${action} (${job.title})`
  // [다시 실행]을 눌렀지만 같은 이슈가 이미 대기·실행 중이라 넣지 않았음(EC-04) — IssueHeader 와 같은 문구
  const [duplicate, setDuplicate] = useState(false)
  return (
    <li className="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5 text-sm" data-testid="e2e-job" data-status={job.status}>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{job.title}</span>
        <span className={`block text-xs ${job.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`} data-testid="e2e-job-status">
          {statusText(job)}
        </span>
        <span role="status" className="block text-xs text-muted-foreground" data-testid="e2e-retry-status">
          {duplicate && '이미 E2E 큐에서 대기·실행 중입니다'}
        </span>
        {job.status === 'running' && job.notice && (
          <span className="block text-xs text-amber-700 dark:text-amber-400" data-testid="e2e-job-notice">
            {NOTICE_TEXT[job.notice]}
          </span>
        )}
      </span>
      {job.status === 'running' && (
        <Button type="button" size="sm" variant="outline" aria-label={named('다음 단계')} onClick={() => q().advance(job.id, job.stage)}>
          다음 단계
        </Button>
      )}
      {active && (
        <Button type="button" size="sm" variant="ghost" aria-label={named('취소')} onClick={() => q().cancel(job.id)}>
          취소
        </Button>
      )}
      {!active && (
        <>
          <Button type="button" size="sm" variant="outline" aria-label={named('다시 실행')} onClick={() => setDuplicate(!q().retry(job.id))}>
            다시 실행
          </Button>
          <Button type="button" size="sm" variant="ghost" aria-label={named('목록에서 지우기')} onClick={() => q().remove(job.id)}>
            목록에서 지우기
          </Button>
        </>
      )}
      {pane !== null && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={named('패널로 이동')}
          onClick={() => {
            goToPane(job.issueId, pane)
            onDone()
          }}
        >
          패널로 이동
        </Button>
      )}
    </li>
  )
}

function RoleSettings() {
  const host = useHost()
  return (
    <div className="grid max-h-[60vh] gap-3 overflow-y-auto pr-1">
      <p className="text-xs text-muted-foreground">
        명령은 [에이전트 실행]에서 정한 CLI 별 명령 틀을 씁니다. 지시문의 <code>{'{issue}'}</code> 는 이슈(번호·제목·주소), <code>{'{out}'}</code> 은 이 단계의 결과 파일,{' '}
        <code>{'{prev}'}</code> 는 앞 단계 결과 파일들로 바뀝니다.
      </p>
      <p className="text-xs text-muted-foreground" data-testid="e2e-models-source">
        목록 출처: {host.label}
      </p>
      {E2E_ROLES.map((r) => (
        <RoleEditor key={r} role={r} />
      ))}
    </div>
  )
}

/** select 에서 "직접 입력…" 을 뜻하는 값 — `_` 로 시작해 모델 이름 패턴(MODEL_RE)과 겹치지 않는다 */
const CUSTOM = '__custom__'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function RoleEditor({ role }: { role: E2eRole }) {
  const uid = useId()
  const cfg = useUiStore((s) => s.e2eRoles[role])
  const save = (patch: Partial<typeof cfg>) => useUiStore.getState().setE2eRole(role, { ...useUiStore.getState().e2eRoles[role], ...patch })
  const models = useAgentModels(cfg.kind)
  // 모델 이름 패턴(EC-05)에 맞지 않는 항목은 저장할 수 없으므로 선택지에서 뺀다
  const list = (models.data ?? []).filter((m) => MODEL_RE.test(m.id))
  // 직접 입력 칸을 연 상태 — 저장한 모델이 목록에 없을 때도 연다
  const [customOpen, setCustomOpen] = useState(false)
  // 패턴에 맞지 않아 저장하지 않은 입력(null = 저장한 값을 보인다)
  const [draft, setDraft] = useState<string | null>(null)
  const inList = list.some((m) => m.id === cfg.model)
  const custom = customOpen || (cfg.model !== '' && !inList && !models.isPending)
  // 목록을 받는 동안에는 저장한 모델을 선택지로 잠깐 보인다
  const pendingSaved = models.isPending && cfg.model !== '' && !inList
  const selectValue = custom ? CUSTOM : cfg.model
  const shown = draft ?? cfg.model
  const invalid = draft !== null

  function pickKind(kind: RoleKind) {
    if (kind === cfg.kind) return
    // 모델은 그 CLI 의 값이라 CLI 를 바꾸면 기본값으로 돌린다
    save({ kind, model: '' })
    setCustomOpen(false)
    setDraft(null)
  }

  function pickModel(value: string) {
    setDraft(null)
    if (value === CUSTOM) {
      setCustomOpen(true)
      return
    }
    setCustomOpen(false)
    save({ model: value })
  }

  function typeModel(value: string) {
    const v = value.trim()
    if (MODEL_RE.test(v)) {
      setDraft(null)
      save({ model: v })
    } else setDraft(value)
  }

  const status = models.isPending
    ? '모델 목록을 불러오는 중…'
    : models.isError
      ? `모델 목록을 불러오지 못했습니다: ${errText(models.error)} — 모델 이름을 직접 입력할 수 있습니다`
      : `모델 ${list.length}개`

  return (
    <fieldset className="grid gap-2 rounded border p-3" data-testid={`e2e-role-${role}`}>
      <legend className="px-1 text-sm font-semibold">{ROLE_LABEL[role]}</legend>
      <RadioGroup aria-label={`${ROLE_LABEL[role]} CLI`} value={cfg.kind} onValueChange={(v) => pickKind(v as RoleKind)} className="flex flex-wrap gap-4">
        {ROLE_KINDS.map((k) => (
          <div key={k} className="flex items-center gap-2">
            <RadioGroupItem id={`${uid}-${k}`} value={k} />
            <Label htmlFor={`${uid}-${k}`}>{LAUNCH_LABEL[k]}</Label>
          </div>
        ))}
      </RadioGroup>

      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`${uid}-model`}>모델</Label>
          <select
            id={`${uid}-model`}
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring"
            value={selectValue}
            onChange={(e) => pickModel(e.target.value)}
          >
            <option value="">기본값(CLI 설정)</option>
            {pendingSaved && <option value={cfg.model}>{cfg.model}</option>}
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name === m.id ? m.id : `${m.name} (${m.id})`}
              </option>
            ))}
            <option value={CUSTOM}>직접 입력…</option>
          </select>
          <Button type="button" size="sm" variant="outline" aria-label="모델 목록 새로 고침" disabled={models.isFetching} onClick={() => void models.refetch()}>
            <RefreshCwIcon className={models.isFetching ? 'animate-spin' : undefined} /> 새로 고침
          </Button>
        </div>
        <p role="status" className={`text-xs ${models.isError ? 'text-destructive' : 'text-muted-foreground'}`}>
          {status}
        </p>
        {custom && (
          <div className="grid gap-1">
            <Label htmlFor={`${uid}-custom`}>모델 이름</Label>
            <Input
              id={`${uid}-custom`}
              value={shown}
              onChange={(e) => typeModel(e.target.value)}
              spellCheck={false}
              className="font-mono"
              placeholder="예: claude-opus-4-1"
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? `${uid}-custom-error` : undefined}
            />
            {invalid && (
              <p id={`${uid}-custom-error`} className="text-xs text-destructive">
                {draft.trim() === ''
                  ? '모델 이름을 입력하세요 — 저장하지 않았습니다(CLI 기본값은 위에서 고릅니다)'
                  : '모델 이름은 영문·숫자로 시작하고 영문·숫자와 . _ : / [ ] - 만 쓸 수 있습니다 — 저장하지 않았습니다'}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-1">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${uid}-prompt`}>지시문</Label>
          {cfg.prompt !== DEFAULT_ROLES[role].prompt && (
            <Button type="button" size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={() => save({ prompt: DEFAULT_ROLES[role].prompt })}>
              기본값
            </Button>
          )}
        </div>
        <Textarea id={`${uid}-prompt`} value={cfg.prompt} onChange={(e) => save({ prompt: e.target.value })} rows={4} />
      </div>
    </fieldset>
  )
}
