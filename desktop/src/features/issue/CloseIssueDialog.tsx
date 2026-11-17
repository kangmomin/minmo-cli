// GitHub 이슈 닫기(#64) — 이유(완료·계획 없음)를 고른다. worktree 는 그대로 둔다.
import { useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import type { IssueCloseReason } from '@minmo/core'

import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Label } from '../../components/ui/label'
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group'
import { useRepoLabel } from '../../store/repos'
import { githubErrorMessage } from '../tree/useTree'
import { useIssueMutations } from './useIssueManage'
import type { ManagedTarget } from './useIssueManage'

export interface CloseIssueDialogProps {
  target: ManagedTarget
  open: boolean
  onOpenChange(open: boolean): void
  /** 닫기에 성공했을 때 */
  onClosed?(): void
  /** 닫기에 성공한 뒤 포커스를 둘 곳 — [이슈 닫기] 버튼이 사라지므로 포커스가 문서 처음으로 가지 않게 */
  focusAfterClose?(): HTMLElement | null
}

const REASONS: { value: IssueCloseReason; label: string; hint: string }[] = [
  { value: 'completed', label: '완료', hint: '작업을 끝냈습니다' },
  { value: 'not_planned', label: '계획 없음', hint: '하지 않기로 했습니다(중복·범위 밖 등)' },
]

export function CloseIssueDialog({ target, open, onOpenChange, onClosed, focusAfterClose }: CloseIssueDialogProps) {
  const repoLabel = useRepoLabel(target.owner, target.repo)
  // 닫는 중에는 닫지 않는다 — 결과를 모른 채 다시 누르지 않게
  const [busy, setBusy] = useState(false)
  const closed = useRef(false)
  return (
    <Dialog open={open} onOpenChange={(o) => (o || !busy) && onOpenChange(o)}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(e) => {
          if (!closed.current) return
          closed.current = false
          const el = focusAfterClose?.()
          if (el) {
            e.preventDefault()
            el.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>이슈 닫기</DialogTitle>
          <DialogDescription>
            {repoLabel} #{target.number} {target.title} 을 GitHub 에서 닫습니다. worktree 는 그대로 남습니다.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <CloseIssueBody
            target={target}
            busy={busy}
            setBusy={setBusy}
            onCancel={() => onOpenChange(false)}
            onClosed={() => {
              closed.current = true
              onClosed?.()
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

type BodyProps = { target: ManagedTarget; busy: boolean; setBusy(b: boolean): void; onCancel(): void; onClosed(): void }

function CloseIssueBody({ target, busy, setBusy, onCancel, onClosed }: BodyProps) {
  const uid = useId()
  const { closeGitHub } = useIssueMutations(target)
  const [reason, setReason] = useState<IssueCloseReason>('completed')
  const [error, setError] = useState<string | null>(null)

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    void closeGitHub(reason)
      .then(onClosed)
      .catch((err: unknown) => setError(githubErrorMessage(err)))
      .finally(() => setBusy(false))
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <RadioGroup aria-label="닫는 이유" value={reason} onValueChange={(v) => setReason(v as IssueCloseReason)} disabled={busy}>
        {REASONS.map((r) => (
          <div key={r.value} className="flex items-start gap-2">
            <RadioGroupItem id={`${uid}-${r.value}`} value={r.value} aria-describedby={`${uid}-${r.value}-hint`} className="mt-0.5" />
            <div className="grid gap-0.5">
              <Label htmlFor={`${uid}-${r.value}`}>{r.label}</Label>
              <span id={`${uid}-${r.value}-hint`} className="text-xs text-muted-foreground">
                {r.hint}
              </span>
            </div>
          </div>
        ))}
      </RadioGroup>
      <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
        {error ?? ''}
      </p>
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          취소
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? '닫는 중…' : '이슈 닫기'}
        </Button>
      </DialogFooter>
    </form>
  )
}
