// GitHub 이슈 등록 — 제목(필수) + 본문(선택). 등록 후에는 트리 목록에만 넣고 선택은 바꾸지 않는다.
import { useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import type { FormEvent } from 'react'

import { useDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { githubErrorMessage, upsertIssueCache } from './useTree'

export interface NewIssueDialogProps {
  owner: string
  repo: string
  open: boolean
  onOpenChange(open: boolean): void
}

export function NewIssueDialog({ owner, repo, open, onOpenChange }: NewIssueDialogProps) {
  // 등록 중에는 닫지 않는다 — 닫고 다시 열어 같은 이슈를 두 번 만들지 않게
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(o) => (o || !busy) && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            이슈 등록 — {owner}/{repo}
          </DialogTitle>
          <DialogDescription>GitHub 에 새 이슈를 만듭니다. 본문은 Markdown 으로 쓸 수 있고 비워도 됩니다.</DialogDescription>
        </DialogHeader>
        {open && <NewIssueBody owner={owner} repo={repo} busy={busy} setBusy={setBusy} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function NewIssueBody({ owner, repo, busy, setBusy, onDone }: { owner: string; repo: string; busy: boolean; setBusy(b: boolean): void; onDone(): void }) {
  const uid = useId()
  const { github } = useDeps()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy || title.trim() === '') return
    setBusy(true)
    setError(null)
    void github
      .createIssue(owner, repo, title.trim(), body.trim())
      .then((issue) => {
        upsertIssueCache(queryClient, owner, repo, issue)
        onDone()
      })
      .catch((err: unknown) => setError(githubErrorMessage(err)))
      .finally(() => setBusy(false))
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor={`${uid}-title`}>제목</Label>
        <Input id={`${uid}-title`} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} placeholder="로그인 화면 만들기" maxLength={256} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${uid}-body`}>본문(선택)</Label>
        <Textarea id={`${uid}-body`} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} rows={8} className="max-h-[50vh] font-mono" />
      </div>
      <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
        {error ?? ''}
      </p>
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={busy} onClick={onDone}>
          취소
        </Button>
        <Button type="submit" disabled={busy || title.trim() === ''}>
          {busy ? '등록 중…' : '등록'}
        </Button>
      </DialogFooter>
    </form>
  )
}
