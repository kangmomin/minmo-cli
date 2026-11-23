import { useId, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { ApiError } from '@minmo/api-client'
import type { SettingsInput, SettingsRecord, SettingsScope, SettingsValues } from '@minmo/api-client'

import { useDeps } from '../../app/deps'
import { HostStatusNotice } from '../../app/HostGate'
import { HostScope, hostOf, useHost, useHostStatus } from '../../app/host'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group'
import { Textarea } from '../../components/ui/textarea'
import { DEFAULT_IGNORED_COPY_EXCLUDE, IGNORED_COPY_OFF, ignoredCopyNames, issueBranchContext, issuePaths } from '@minmo/core'
import { LOCAL_HOST_ID, aliasOfHostId, baseDirOf, baseRepoOf, hostIdOf, repoAliasOf, repoHostOf, useHostsStore, useOriginFolder } from '../../store/hosts'
import { clampNickname, isLocalOwner, normalizeNickname, repoKey, repoLabelOf, repoNicknameOf, repoShortNameOf, shortNameTaken, useReposStore } from '../../store/repos'
import { useSessionStore } from '../../store/session'
import { PairSyncSection } from '../pairSync/PairSyncSection'
import { BaseRepoDialog } from '../tree/BaseRepoDialog'
import { useSettings } from './useSettings'

export type PreviewIssue = { owner: string; repo: string; key: string; number: number | null; title: string }

export interface SettingsDialogProps {
  scope: SettingsScope
  open: boolean
  onOpenChange(open: boolean): void
  /** 하단 미리보기 기준 이슈(브랜치명·해석된 worktree 경로) */
  previewIssue?: PreviewIssue | null
}

type TextField = 'branchTemplate' | 'etcBranchName' | 'worktreePath' | 'mainClonePath'
type ScriptMode = 'inherit' | 'none' | 'custom'
type SparseMode = 'inherit' | 'all' | 'custom'
type IgnoredMode = 'inherit' | 'on' | 'off'

const TEXT_FIELDS: { field: TextField; label: string; hint: string }[] = [
  { field: 'branchTemplate', label: '브랜치 템플릿', hint: '{number} 필수 · {slug} {title}' },
  { field: 'etcBranchName', label: '기타 브랜치명', hint: '★기타 이슈의 브랜치' },
  { field: 'worktreePath', label: 'worktree 경로', hint: '{branch} 또는 {key} 필수 · {owner} {repo} {alias}(별칭) {number} {slug} · ~ = 홈 · ./ ../ = 원본 폴더 기준(예: ../{repo}-wt/{branch})' },
  { field: 'mainClonePath', label: '메인 clone 경로', hint: '{owner} {repo}' },
]

const ERROR_TEXT: Record<string, string> = {
  invalid_template: '템플릿 형식이 올바르지 않습니다',
  invalid_path_template: '경로 템플릿 형식이 올바르지 않습니다',
  global_requires_all_fields: '전역 설정은 이 값을 비울 수 없습니다',
  script_too_large: '스크립트가 64 KiB 를 넘습니다',
  invalid_sparse_paths: '저장소 기준 상대 폴더만 한 줄에 하나씩 적을 수 있습니다 (glob·.. 불가)',
  invalid_ignored_copy_exclude: '폴더·파일 이름만 한 줄에 하나씩 적을 수 있습니다 (경로·.. 불가)',
  invalid_json: '값의 형식이 올바르지 않습니다',
}

function scopeTitle(scope: SettingsScope, repoLabel: string): string {
  if (scope.kind === 'global') return '전역 설정'
  if (scope.kind === 'org') return isLocalOwner(scope.owner) ? '로컬 저장소 공통 설정' : `조직 설정 — ${scope.owner}`
  return `프로젝트 설정 — ${repoLabel}`
}

export function SettingsDialog({ scope, open, onOpenChange, previewIssue }: SettingsDialogProps) {
  const project = scope.kind === 'project' && !isLocalOwner(scope.owner) ? scope : null
  // 연결 호스트를 정한 저장소는 원본 위치·경로 미리보기를 그 호스트 기준으로 보인다. 정하지 않았으면 바깥(작업 호스트) 그대로
  const bound = useHostsStore((s) => (project ? repoAliasOf(s, project.owner, project.repo) : undefined))
  const outer = useHost().alias
  const alias = bound === undefined ? outer : bound
  const status = useHostStatus(bound ?? null)
  // 별칭을 바꾸면 제목도 바로 바뀌게 구독한다
  const repoLabel = useReposStore((s) => (scope.kind === 'project' ? repoLabelOf(s, scope.owner, scope.repo) : ''))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{scopeTitle(scope, repoLabel)}</DialogTitle>
          <DialogDescription>
            {scope.kind === 'global'
              ? '모든 저장소의 기본값입니다.'
              : '비워 두면 상위 설정을 상속합니다. 상속 값은 입력란에 회색으로 표시됩니다.'}
          </DialogDescription>
        </DialogHeader>
        {open && scope.kind === 'global' && <PairSyncSection />}
        {open && scope.kind === 'project' && <RepoNicknameSection key={repoKey(scope.owner, scope.repo)} owner={scope.owner} repo={scope.repo} />}
        {open && project && <RepoHostSection owner={project.owner} repo={project.repo} />}
        {open &&
          project &&
          (status.ready ? (
            <HostScope alias={alias}>
              <BaseRepoSection owner={project.owner} repo={project.repo} />
            </HostScope>
          ) : (
            // 연결 호스트에 닿기 전에는 그 호스트의 원본 위치를 보일 수 없다 — 아래 서버 설정은 호스트와 관계없으므로 그대로 쓴다
            <HostStatusNotice alias={bound ?? ''} status={status} className="grid gap-2 rounded border p-3 text-sm" testId="settings-host-status" />
          ))}
        {/* 연결 호스트를 바꿔도 폼이 다시 마운트되지 않게(입력이 남게) 항상 같은 HostScope 아래에 둔다. 연결 전에는 미리보기를 감춘다 */}
        {open && (
          <HostScope alias={alias}>
            <SettingsBody scope={scope} previewIssue={status.ready ? (previewIssue ?? null) : null} onSaved={() => onOpenChange(false)} />
          </HostScope>
        )}
      </DialogContent>
    </Dialog>
  )
}

const hostLabelOf = (hostId: string) => hostOf(aliasOfHostId(hostId) ?? null).label

/**
 * 저장소 별칭(#73) — 이 PC 에 저장하는 값이라 연결 호스트처럼 아래 폼의 [저장] 과 따로 두고, 입력하면 바로 적용한다.
 * 입력란은 자기 값을 따로 들고 정리한 값만 저장한다(저장값으로 그리면 칠 때마다 끝 공백이 지워져 띄어 쓸 수 없다)
 */
function RepoNicknameSection({ owner, repo }: { owner: string; repo: string }) {
  const uid = useId()
  const saved = useReposStore((s) => repoNicknameOf(s, owner, repo) ?? '')
  const [draft, setDraft] = useState(saved)
  // 바깥(원격 접속 화면 등)에서 바뀐 별칭을 입력란에 반영한다 — 입력 중인 값과 같은 뜻이면(끝 공백 차이) 그대로 둔다
  const [seen, setSeen] = useState(saved)
  if (saved !== seen) {
    setSeen(saved)
    if (normalizeNickname(draft) !== saved) setDraft(saved)
  }
  // 별칭이 없을 때 보이는 이름
  const original = useReposStore((s) => repoShortNameOf({ local: s.local, nicknames: {} }, owner, repo))
  // {alias} 를 경로에 쓰면 이름이 같은 저장소끼리 폴더가 겹친다 — 막지는 않고 알린다
  const duplicate = useReposStore((s) => shortNameTaken(s, owner, repo, draft))
  return (
    <div className="grid gap-1 rounded border p-3" data-testid="repo-nickname-section">
      <div className="flex items-center gap-2">
        <label htmlFor={uid} className="shrink-0 text-sm font-medium">
          별칭
        </label>
        <Input
          id={uid}
          value={draft}
          placeholder={original}
          aria-describedby={`${uid}-hint ${uid}-dup`}
          onChange={(e) => {
            // maxLength 는 UTF-16 단위라 저장 규칙(글자 수)과 어긋난다 — 같은 함수로 자른다
            const v = clampNickname(e.target.value)
            setDraft(v)
            useReposStore.getState().setNickname(owner, repo, v)
          }}
          spellCheck={false}
          className="ml-auto h-7 max-w-64 text-sm"
        />
      </div>
      <p id={`${uid}-hint`} className="text-xs text-muted-foreground">
        이 PC 에만 저장합니다. 트리·이슈 머리줄 등에 원래 이름 대신 보이고, worktree 경로의 {'{alias}'} 값이 됩니다. 비우면 원래 이름을 씁니다.
      </p>
      {/* live region 은 미리 렌더해 두어야 변화가 읽힌다 */}
      <p id={`${uid}-dup`} role="status" className="text-xs text-amber-600 dark:text-amber-400">
        {duplicate ? '이 PC 의 다른 저장소와 이름(별칭)이 같습니다 — 경로에 {alias} 를 쓰면 폴더가 겹칠 수 있습니다' : ''}
      </p>
    </div>
  )
}

/**
 * 연결 호스트 — 이 저장소의 이슈를 여는 호스트. 원본 위치처럼 이 PC 에 저장하는 값이라 바꾸면 바로 적용한다.
 * 연결이 안 되는 호스트를 골랐어도 여기서 다시 바꿀 수 있게 아래 영역(호스트 연결 필요)과 따로 둔다
 */
function RepoHostSection({ owner, repo }: { owner: string; repo: string }) {
  const uid = useId()
  const aliases = useHostsStore((s) => s.aliases)
  const current = useHostsStore((s) => repoHostOf(s, owner, repo))
  const setRepoHost = useHostsStore((s) => s.setRepoHost)
  const options = [LOCAL_HOST_ID, ...aliases.map(hostIdOf)]
  // 목록에서 빠졌거나 이 기기의 목록에 없는 호스트(원격 접속 화면)에 묶여 있어도 값이 비지 않게
  if (current !== undefined && !options.includes(current)) options.push(current)
  return (
    <div className="grid gap-1 rounded border p-3" data-testid="repo-host-section">
      <div className="flex items-center gap-2">
        <label htmlFor={uid} className="text-sm font-medium">
          연결 호스트
        </label>
        <select
          id={uid}
          className="ml-auto h-7 min-w-0 rounded border bg-background px-1.5 text-sm"
          value={current ?? ''}
          onChange={(e) => setRepoHost(owner, repo, e.target.value === '' ? null : e.target.value)}
        >
          <option value="">작업 호스트 따름</option>
          {options.map((id) => (
            <option key={id} value={id}>
              {hostLabelOf(id)}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        이 저장소의 이슈를 여는 호스트입니다. 정하면 사이드바의 작업 호스트와 관계없이 이 호스트에서 worktree·터미널을 엽니다.
      </p>
    </div>
  )
}

/**
 * 원본 위치(기준 저장소 폴더) — 서버 설정이 아니라 이 PC 에 호스트별로 저장하는 값이라 아래 폼의 [저장] 과 따로 둔다.
 * 서버에 닿지 않아도 볼 수 있게 폼 밖에 있다
 */
function BaseRepoSection({ owner, repo }: { owner: string; repo: string }) {
  const host = useHost()
  const current = useHostsStore((s) => baseRepoOf(s, host.id, owner, repo))
  const [open, setOpen] = useState(false)
  return (
    <div className="grid gap-1 rounded border p-3" data-testid="base-repo-section">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">원본 위치 ({host.label})</span>
        <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => setOpen(true)}>
          변경…
        </Button>
      </div>
      <p className="break-all font-mono text-xs" data-testid="base-repo-current">
        {current ?? '지정 안 함 — 아래 설정의 메인 clone 경로에 새로 clone 합니다'}
      </p>
      <p className="text-xs text-muted-foreground">이 호스트에 이미 있는 저장소 폴더입니다. 호스트마다 따로 정합니다.</p>
      <BaseRepoDialog owner={owner} repo={repo} open={open} onOpenChange={setOpen} />
    </div>
  )
}

function SettingsBody({ scope, previewIssue, onSaved }: { scope: SettingsScope; previewIssue: PreviewIssue | null; onSaved(): void }) {
  const s = useSettings(scope)
  const ready = s.record !== undefined && (scope.kind === 'global' || s.inherited !== null)
  if (!ready) {
    return <p className="text-sm text-muted-foreground">{s.isLoading ? '불러오는 중…' : '설정을 불러올 수 없습니다 — 서버 연결 필요'}</p>
  }
  // 레코드가 바뀌면(저장 후 재조회) 폼을 새로 초기화한다
  return (
    <SettingsForm
      key={s.record!.updatedAt ?? 'empty'}
      scope={scope}
      record={s.record!}
      inherited={s.inherited}
      save={s.save}
      isSaving={s.isSaving}
      previewIssue={previewIssue}
      onSaved={onSaved}
    />
  )
}

function initialScriptMode(scope: SettingsScope, v: string | null): ScriptMode {
  if (v === null) return scope.kind === 'global' ? 'none' : 'inherit'
  return v === '' ? 'none' : 'custom'
}

/** 생성 후 스크립트 3상태(상속/없음/직접 입력) — OS 별 두 벌에 같은 UI 를 쓴다 */
function ScriptSection(props: {
  idPrefix: string
  title: string
  contentLabel: string
  shell: string
  isGlobal: boolean
  mode: ScriptMode
  onModeChange(m: ScriptMode): void
  value: string
  onValueChange(v: string): void
  inherited: string | undefined
  error: string | undefined
}) {
  const { idPrefix: id, error } = props
  return (
    <div className="grid gap-2">
      <span id={`${id}-group`} className="text-sm font-medium">
        {props.title}
      </span>
      <RadioGroup
        aria-labelledby={`${id}-group`}
        value={props.mode}
        onValueChange={(v) => props.onModeChange(v as ScriptMode)}
        className="flex gap-4"
      >
        {!props.isGlobal && (
          <div className="flex items-center gap-2">
            <RadioGroupItem id={`${id}-inherit`} value="inherit" />
            <Label htmlFor={`${id}-inherit`}>상속</Label>
          </div>
        )}
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${id}-none`} value="none" />
          <Label htmlFor={`${id}-none`}>없음</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${id}-custom`} value="custom" />
          <Label htmlFor={`${id}-custom`}>직접 입력</Label>
        </div>
      </RadioGroup>
      {props.mode === 'inherit' && props.inherited !== undefined && (
        <p className="text-xs text-muted-foreground">상속: {props.inherited === '' ? '(없음)' : props.inherited.split('\n')[0]}</p>
      )}
      {props.mode === 'custom' && (
        <div className="grid gap-1.5">
          <Label htmlFor={id}>{props.contentLabel}</Label>
          <Textarea
            id={id}
            value={props.value}
            rows={5}
            className="font-mono"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
            onChange={(e) => props.onValueChange(e.target.value)}
            spellCheck={false}
          />
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {`worktree 생성 직후 1회 실행 (${props.shell}) · env MINMO_OWNER, MINMO_REPO, MINMO_BRANCH, MINMO_WORKTREE …`}
          </p>
          {error && (
            <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function initialSparseMode(scope: SettingsScope, v: string | null): SparseMode {
  if (v === null) return scope.kind === 'global' ? 'all' : 'inherit'
  return v === '' ? 'all' : 'custom'
}

/** 줄 목록 요약(상속 표시용) */
function sparseSummary(v: string): string {
  const dirs = v.split('\n').map((l) => l.trim()).filter(Boolean)
  return dirs.length === 0 ? '(전체)' : dirs.join(', ')
}

function initialIgnoredMode(scope: SettingsScope, v: string | null | undefined): IgnoredMode {
  if (v == null) return scope.kind === 'global' ? 'on' : 'inherit'
  return ignoredCopyNames(v) === null ? 'off' : 'on'
}

function ignoredSummary(v: string): string {
  const names = ignoredCopyNames(v)
  if (names === null) return '가져오지 않음'
  return names.size === 0 ? '모두 가져옴' : `가져옴 · 제외: ${[...names].join(', ')}`
}

function SettingsForm(props: {
  scope: SettingsScope
  record: SettingsRecord
  inherited: SettingsValues | null
  save(input: SettingsInput): Promise<SettingsRecord>
  isSaving: boolean
  previewIssue: PreviewIssue | null
  onSaved(): void
}) {
  const { scope, record, inherited, previewIssue } = props
  const { home, platform } = useDeps()
  const host = useHost()
  const hostLabel = host.label
  const baseDir = useHostsStore((st) => baseDirOf(st, host.id))
  const offline = useSessionStore((st) => st.status === 'offline')
  const uid = useId()
  const isGlobal = scope.kind === 'global'

  const [text, setText] = useState<Record<TextField, string>>(() => ({
    branchTemplate: record.branchTemplate ?? '',
    etcBranchName: record.etcBranchName ?? '',
    worktreePath: record.worktreePath ?? '',
    mainClonePath: record.mainClonePath ?? '',
  }))
  const [scriptMode, setScriptMode] = useState<ScriptMode>(() => initialScriptMode(scope, record.postCreateScript))
  const [script, setScript] = useState(record.postCreateScript ?? '')
  const [posixMode, setPosixMode] = useState<ScriptMode>(() => initialScriptMode(scope, record.postCreateScriptPosix))
  const [posixScript, setPosixScript] = useState(record.postCreateScriptPosix ?? '')
  const [sparseMode, setSparseMode] = useState<SparseMode>(() => initialSparseMode(scope, record.sparsePaths))
  const [sparse, setSparse] = useState(record.sparsePaths ?? '')
  const [ignoredMode, setIgnoredMode] = useState<IgnoredMode>(() => initialIgnoredMode(scope, record.ignoredCopyExclude))
  // 꺼져 있거나 상속 중이면 켰을 때 채울 목록을 미리 넣어 둔다(상속값, 없으면 기본 제외 목록)
  const [ignored, setIgnored] = useState(() => {
    const own = record.ignoredCopyExclude
    if (own != null && ignoredCopyNames(own) !== null) return own
    const up = inherited?.ignoredCopyExclude
    return up != null && ignoredCopyNames(up) !== null ? up : DEFAULT_IGNORED_COPY_EXCLUDE
  })
  const [errors, setErrors] = useState<Partial<Record<keyof SettingsValues, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)

  // 미리보기 이슈의 원본 폴더 — 이슈 열기(useWorktree)와 같은 규칙. 없으면 메인 clone 경로
  const origin = useOriginFolder(host.id, previewIssue?.owner ?? '', previewIssue?.repo ?? '')
  // 경로의 {alias} — 이슈 열기와 같은 값(위의 별칭 칸을 고치면 바로 반영된다)
  const previewNickname = useReposStore((st) => (previewIssue ? repoShortNameOf(st, previewIssue.owner, previewIssue.repo) : undefined))

  // 미리보기: 입력값(비어 있으면 상속값)으로 계산
  const effective = useMemo(() => {
    const pick = (f: TextField) => (text[f] !== '' || !inherited ? text[f] : inherited[f])
    return {
      branchTemplate: pick('branchTemplate'),
      etcBranchName: pick('etcBranchName'),
      worktreePath: pick('worktreePath'),
      mainClonePath: pick('mainClonePath'),
    }
  }, [text, inherited])

  const preview = useMemo(() => {
    if (!previewIssue) return null
    let resolved: ReturnType<typeof issueBranchContext>
    try {
      resolved = issueBranchContext(effective, previewIssue, { home, platform, nickname: previewNickname }, { checkEtcConflict: true })
    } catch {
      return { branch: '브랜치명이 기타 브랜치와 충돌', path: '—' }
    }
    const values = { ...effective, mainClonePath: origin ?? effective.mainClonePath }
    return { branch: resolved.branch, path: issuePaths(values, resolved.ctx, baseDir).path }
  }, [effective, previewIssue, home, platform, baseDir, origin, previewNickname])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErrors({})
    setFormError(null)
    const value = (f: TextField): string | null => (isGlobal ? text[f] : text[f] === '' ? null : text[f])
    const input: SettingsInput = {
      branchTemplate: value('branchTemplate'),
      etcBranchName: value('etcBranchName'),
      worktreePath: value('worktreePath'),
      mainClonePath: value('mainClonePath'),
      postCreateScript: scriptMode === 'inherit' ? null : scriptMode === 'none' ? '' : script,
      postCreateScriptPosix: posixMode === 'inherit' ? null : posixMode === 'none' ? '' : posixScript,
      sparsePaths: sparseMode === 'inherit' ? null : sparseMode === 'all' ? '' : sparse,
      ignoredCopyExclude: ignoredMode === 'inherit' ? null : ignoredMode === 'off' ? IGNORED_COPY_OFF : ignored,
    }
    try {
      await props.save(input)
      props.onSaved()
    } catch (err) {
      if (err instanceof ApiError && err.field) {
        setErrors({ [err.field]: ERROR_TEXT[err.code] ?? `저장 실패(${err.code})` })
      } else if (err instanceof ApiError) {
        setFormError(`저장 실패(${err.code})`)
      } else {
        setFormError(`저장 실패 — ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const fieldId = (f: string) => `${uid}-${f}`

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
      <fieldset disabled={offline} className="grid gap-4">
        {TEXT_FIELDS.map(({ field, label, hint }) => (
          <div key={field} className="grid gap-1.5">
            <Label htmlFor={fieldId(field)}>{label}</Label>
            <Input
              id={fieldId(field)}
              value={text[field]}
              placeholder={inherited ? `상속: ${inherited[field]}` : undefined}
              aria-invalid={errors[field] ? true : undefined}
              aria-describedby={errors[field] ? `${fieldId(field)}-hint ${fieldId(field)}-error` : `${fieldId(field)}-hint`}
              onChange={(e) => setText((t) => ({ ...t, [field]: e.target.value }))}
              spellCheck={false}
            />
            {/* 힌트는 그대로 두고 오류는 새로 삽입되는 alert 노드로 — 같은 요소의 role 을 바꾸지 않는다(AX-20) */}
            <p id={`${fieldId(field)}-hint`} className="text-xs text-muted-foreground">
              {hint}
            </p>
            {errors[field] && (
              <p id={`${fieldId(field)}-error`} role="alert" className="text-xs text-destructive">
                {errors[field]}
              </p>
            )}
          </div>
        ))}

        {/* 스크립트는 실행 셸이 OS 마다 달라 두 벌이다 — Windows 데스크탑은 PowerShell, macOS 데스크탑·원격 CLI 는 sh */}
        <ScriptSection
          idPrefix={fieldId('script')}
          title="생성 후 스크립트"
          contentLabel="스크립트 내용"
          shell={`Windows · PowerShell${platform === 'win32' ? ` · ${hostLabel}` : ''}`}
          isGlobal={isGlobal}
          mode={scriptMode}
          onModeChange={setScriptMode}
          value={script}
          onValueChange={setScript}
          inherited={inherited?.postCreateScript}
          error={errors.postCreateScript}
        />
        <ScriptSection
          idPrefix={fieldId('script-posix')}
          title="생성 후 스크립트 (Linux/macOS)"
          contentLabel="스크립트 내용 (Linux/macOS)"
          shell={`sh · 원격 호스트·CLI${platform !== 'win32' ? ` · ${hostLabel}` : ''}`}
          isGlobal={isGlobal}
          mode={posixMode}
          onModeChange={setPosixMode}
          value={posixScript}
          onValueChange={setPosixScript}
          inherited={inherited?.postCreateScriptPosix}
          error={errors.postCreateScriptPosix}
        />

        <div className="grid gap-2">
          <span id={fieldId('sparse-group')} className="text-sm font-medium">
            체크아웃 범위
          </span>
          <RadioGroup
            aria-labelledby={fieldId('sparse-group')}
            value={sparseMode}
            onValueChange={(v) => setSparseMode(v as SparseMode)}
            className="flex gap-4"
          >
            {!isGlobal && (
              <div className="flex items-center gap-2">
                <RadioGroupItem id={fieldId('sparse-inherit')} value="inherit" />
                <Label htmlFor={fieldId('sparse-inherit')}>상속</Label>
              </div>
            )}
            <div className="flex items-center gap-2">
              <RadioGroupItem id={fieldId('sparse-all')} value="all" />
              <Label htmlFor={fieldId('sparse-all')}>전체</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id={fieldId('sparse-custom')} value="custom" />
              <Label htmlFor={fieldId('sparse-custom')}>지정한 폴더만</Label>
            </div>
          </RadioGroup>
          {sparseMode === 'inherit' && inherited && (
            <p className="text-xs text-muted-foreground">상속: {sparseSummary(inherited.sparsePaths)}</p>
          )}
          {sparseMode === 'custom' && (
            <div className="grid gap-1.5">
              <Label htmlFor={fieldId('sparse')}>폴더 목록</Label>
              <Textarea
                id={fieldId('sparse')}
                value={sparse}
                rows={4}
                className="font-mono"
                placeholder={'desktop\npackages/api-client'}
                aria-invalid={errors.sparsePaths ? true : undefined}
                aria-describedby={errors.sparsePaths ? `${fieldId('sparse-hint')} ${fieldId('sparse-error')}` : fieldId('sparse-hint')}
                onChange={(e) => setSparse(e.target.value)}
                spellCheck={false}
              />
              <p id={fieldId('sparse-hint')} className="text-xs text-muted-foreground">
                저장소 기준 폴더를 한 줄에 하나씩 · 새로 만드는 worktree 부터 적용 · 루트의 파일은 항상 포함
              </p>
              {errors.sparsePaths && (
                <p id={fieldId('sparse-error')} role="alert" className="text-xs text-destructive">
                  {errors.sparsePaths}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="grid gap-2">
          <span id={fieldId('ignored-group')} className="text-sm font-medium">
            무시된 파일 가져오기
          </span>
          <RadioGroup
            aria-labelledby={fieldId('ignored-group')}
            aria-describedby={fieldId('ignored-desc')}
            value={ignoredMode}
            onValueChange={(v) => setIgnoredMode(v as IgnoredMode)}
            className="flex gap-4"
          >
            {!isGlobal && (
              <div className="flex items-center gap-2">
                <RadioGroupItem id={fieldId('ignored-inherit')} value="inherit" />
                <Label htmlFor={fieldId('ignored-inherit')}>상속</Label>
              </div>
            )}
            <div className="flex items-center gap-2">
              <RadioGroupItem id={fieldId('ignored-on')} value="on" />
              <Label htmlFor={fieldId('ignored-on')}>가져오기</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id={fieldId('ignored-off')} value="off" />
              <Label htmlFor={fieldId('ignored-off')}>가져오지 않음</Label>
            </div>
          </RadioGroup>
          <p id={fieldId('ignored-desc')} className="text-xs text-muted-foreground">
            새 worktree 를 만들 때 .gitignore 로 빠진 파일(.env 등)을 원본 폴더에서 복사합니다 · 원본: 기준·로컬 저장소 폴더, 없으면 ★기타 worktree, 그다음
            최근에 커밋한 worktree
          </p>
          {ignoredMode === 'inherit' && inherited && (
            <p className="text-xs text-muted-foreground">상속: {ignoredSummary(inherited.ignoredCopyExclude ?? DEFAULT_IGNORED_COPY_EXCLUDE)}</p>
          )}
          {ignoredMode === 'on' && (
            <div className="grid gap-1.5">
              <Label htmlFor={fieldId('ignored')}>가져오지 않을 폴더·파일 이름</Label>
              <Textarea
                id={fieldId('ignored')}
                value={ignored}
                rows={4}
                className="font-mono"
                aria-invalid={errors.ignoredCopyExclude ? true : undefined}
                aria-describedby={errors.ignoredCopyExclude ? `${fieldId('ignored-hint')} ${fieldId('ignored-error')}` : fieldId('ignored-hint')}
                onChange={(e) => setIgnored(e.target.value)}
                spellCheck={false}
              />
              <p id={fieldId('ignored-hint')} className="text-xs text-muted-foreground">
                이름을 한 줄에 하나씩(패턴 불가) · 경로 어디에든 이 이름이 있으면 복사하지 않습니다 · 여기 없는 큰 폴더는 그대로 복사되니 추가하세요 · 비우면 전부 복사
              </p>
              {errors.ignoredCopyExclude && (
                <p id={fieldId('ignored-error')} role="alert" className="text-xs text-destructive">
                  {errors.ignoredCopyExclude}
                </p>
              )}
            </div>
          )}
        </div>
      </fieldset>

      {preview && (
        <div className="grid gap-1 rounded-md bg-muted p-3 text-xs">
          <div>
            브랜치: <code data-testid="preview-branch">{preview.branch}</code>
          </div>
          <div>
            worktree: <code data-testid="preview-path">{preview.path}</code>
          </div>
        </div>
      )}

      {formError && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}
      {offline && <p className="text-sm text-muted-foreground">서버 미연결 — 설정을 편집할 수 없습니다</p>}

      <DialogFooter>
        <Button type="submit" disabled={offline || props.isSaving}>
          저장
        </Button>
      </DialogFooter>
    </form>
  )
}
