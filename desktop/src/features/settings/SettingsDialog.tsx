import { useId, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { ApiError, renderBranch, renderPath, slug } from '@minmo/api-client'
import type { SettingsInput, SettingsRecord, SettingsScope, SettingsValues } from '@minmo/api-client'

import { useDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group'
import { Textarea } from '../../components/ui/textarea'
import { useSessionStore } from '../../store/session'
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

const TEXT_FIELDS: { field: TextField; label: string; hint: string }[] = [
  { field: 'branchTemplate', label: '브랜치 템플릿', hint: '{number} 필수 · {slug} {title}' },
  { field: 'etcBranchName', label: '기타 브랜치명', hint: '★기타 이슈의 브랜치' },
  { field: 'worktreePath', label: 'worktree 경로', hint: '{branch} 또는 {key} 필수 · {owner} {repo} {number} {slug} · ~ = 홈' },
  { field: 'mainClonePath', label: '메인 clone 경로', hint: '{owner} {repo}' },
]

const ERROR_TEXT: Record<string, string> = {
  invalid_template: '템플릿 형식이 올바르지 않습니다',
  invalid_path_template: '경로 템플릿 형식이 올바르지 않습니다',
  global_requires_all_fields: '전역 설정은 이 값을 비울 수 없습니다',
  script_too_large: '스크립트가 64 KiB 를 넘습니다',
  invalid_json: '값의 형식이 올바르지 않습니다',
}

function scopeTitle(scope: SettingsScope): string {
  if (scope.kind === 'global') return '전역 설정'
  if (scope.kind === 'org') return `조직 설정 — ${scope.owner}`
  return `프로젝트 설정 — ${scope.owner}/${scope.repo}`
}

export function SettingsDialog({ scope, open, onOpenChange, previewIssue }: SettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{scopeTitle(scope)}</DialogTitle>
          <DialogDescription>
            {scope.kind === 'global'
              ? '모든 저장소의 기본값입니다.'
              : '비워 두면 상위 설정을 상속합니다. 상속 값은 입력란에 회색으로 표시됩니다.'}
          </DialogDescription>
        </DialogHeader>
        {open && <SettingsBody scope={scope} previewIssue={previewIssue ?? null} onSaved={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
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
  const [errors, setErrors] = useState<Partial<Record<keyof SettingsValues, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)

  // 미리보기: 입력값(비어 있으면 상속값)으로 계산
  const effective = useMemo(() => {
    const pick = (f: TextField) => (text[f] !== '' || !inherited ? text[f] : inherited[f])
    return {
      branchTemplate: pick('branchTemplate'),
      etcBranchName: pick('etcBranchName'),
      worktreePath: pick('worktreePath'),
    }
  }, [text, inherited])

  const preview = useMemo(() => {
    if (!previewIssue) return null
    let branch: string
    try {
      branch =
        previewIssue.number === null
          ? effective.etcBranchName
          : renderBranch(effective.branchTemplate, { number: previewIssue.number, title: previewIssue.title }, { etcBranchName: effective.etcBranchName })
    } catch {
      return { branch: '브랜치명이 기타 브랜치와 충돌', path: '—' }
    }
    const path = renderPath(effective.worktreePath, {
      owner: previewIssue.owner,
      repo: previewIssue.repo,
      branch,
      key: previewIssue.key,
      number: previewIssue.number,
      slug: previewIssue.number === null ? '' : slug(previewIssue.title),
      home,
      platform,
    })
    return { branch, path }
  }, [effective, previewIssue, home, platform])

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
              aria-describedby={`${fieldId(field)}-hint`}
              onChange={(e) => setText((t) => ({ ...t, [field]: e.target.value }))}
              spellCheck={false}
            />
            <p id={`${fieldId(field)}-hint`} className={errors[field] ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
              {errors[field] ?? hint}
            </p>
          </div>
        ))}

        <div className="grid gap-2">
          <span id={fieldId('script-group')} className="text-sm font-medium">
            생성 후 스크립트
          </span>
          <RadioGroup
            aria-labelledby={fieldId('script-group')}
            value={scriptMode}
            onValueChange={(v) => setScriptMode(v as ScriptMode)}
            className="flex gap-4"
          >
            {!isGlobal && (
              <div className="flex items-center gap-2">
                <RadioGroupItem id={fieldId('script-inherit')} value="inherit" />
                <Label htmlFor={fieldId('script-inherit')}>상속</Label>
              </div>
            )}
            <div className="flex items-center gap-2">
              <RadioGroupItem id={fieldId('script-none')} value="none" />
              <Label htmlFor={fieldId('script-none')}>없음</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id={fieldId('script-custom')} value="custom" />
              <Label htmlFor={fieldId('script-custom')}>직접 입력</Label>
            </div>
          </RadioGroup>
          {scriptMode === 'inherit' && inherited && (
            <p className="text-xs text-muted-foreground">
              상속: {inherited.postCreateScript === '' ? '(없음)' : inherited.postCreateScript.split('\n')[0]}
            </p>
          )}
          {scriptMode === 'custom' && (
            <div className="grid gap-1.5">
              <Label htmlFor={fieldId('script')}>스크립트 내용</Label>
              <Textarea
                id={fieldId('script')}
                value={script}
                rows={5}
                className="font-mono"
                aria-invalid={errors.postCreateScript ? true : undefined}
                onChange={(e) => setScript(e.target.value)}
                spellCheck={false}
              />
              <p className={errors.postCreateScript ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                {errors.postCreateScript ??
                  `worktree 생성 직후 1회 실행 (${platform === 'win32' ? 'PowerShell' : 'sh'}) · env MINMO_OWNER, MINMO_REPO, MINMO_BRANCH, MINMO_WORKTREE …`}
              </p>
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

      {formError && <p className="text-sm text-destructive">{formError}</p>}
      {offline && <p className="text-sm text-muted-foreground">서버 미연결 — 설정을 편집할 수 없습니다</p>}

      <DialogFooter>
        <Button type="submit" disabled={offline || props.isSaving}>
          저장
        </Button>
      </DialogFooter>
    </form>
  )
}
