// 이슈 수정(#64) — GitHub 이슈는 제목·본문, 로컬 작업은 제목만. 바뀐 필드만 보낸다.
import { useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import type { FormEvent } from 'react'

import type { UpdateIssueInput } from '@minmo/core'

import { useDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { queryKeys } from '../../lib/queryKeys'
import { useRepoLabel } from '../../store/repos'
import { githubErrorMessage } from '../tree/useTree'
import { useIssueMutations } from './useIssueManage'
import type { IssueManageInfo, ManagedTarget } from './useIssueManage'

export interface EditIssueDialogProps {
  target: ManagedTarget
  info: IssueManageInfo
  open: boolean
  onOpenChange(open: boolean): void
}

type Initial = { title: string; body: string | null }
type FormProps = { busy: boolean; setBusy(b: boolean): void; onDone(): void }

export function EditIssueDialog({ target, info, open, onOpenChange }: EditIssueDialogProps) {
  const repoLabel = useRepoLabel(target.owner, target.repo)
  const mutations = useIssueMutations(target)
  // 저장 중에는 닫지 않는다 — 결과를 모른 채 다시 열어 고치지 않게
  const [busy, setBusy] = useState(false)
  const form: FormProps = { busy, setBusy, onDone: () => onOpenChange(false) }
  const isTask = info.kind === 'task'
  return (
    <Dialog open={open} onOpenChange={(o) => (o || !busy) && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isTask ? '작업 수정' : '이슈 수정'} — {repoLabel} #{target.number}
          </DialogTitle>
          <DialogDescription>{isTask ? '작업 제목을 바꿉니다.' : 'GitHub 이슈의 제목과 본문을 바꿉니다. 본문은 Markdown 으로 씁니다.'}</DialogDescription>
        </DialogHeader>
        {open &&
          (isTask ? (
            <EditForm {...form} initial={{ title: info.title, body: null }} save={async (input) => mutations.renameTask(input.title ?? info.title)} />
          ) : (
            <GitHubEditBody {...form} target={target} save={mutations.updateGitHub} />
          ))}
      </DialogContent>
    </Dialog>
  )
}

function GitHubEditBody({ target, save, ...form }: FormProps & { target: ManagedTarget; save(input: UpdateIssueInput): Promise<void> }) {
  const { github } = useDeps()
  // 열 때마다 GitHub 에서 새로 받는다 — 다른 곳에서 고친 본문을 옛 값으로 덮어쓰지 않게(gcTime 0: 닫으면 버린다)
  const issue = useQuery({
    queryKey: queryKeys.githubIssue(target.owner, target.repo, target.number),
    queryFn: () => github.getIssue(target.owner, target.repo, target.number),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  // 한 번 받은 뒤에는 폼을 그대로 둔다 — 새로고침 등으로 다시 조회하다 실패해도 쓰던 내용을 잃지 않게
  if (issue.data === undefined) {
    if (!issue.isError) return <p className="text-sm text-muted-foreground">불러오는 중…</p>
    return (
      <div className="grid gap-3">
        <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
          {githubErrorMessage(issue.error)}
        </p>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={form.onDone}>
            취소
          </Button>
          <Button type="button" disabled={issue.isFetching} onClick={() => void issue.refetch()}>
            다시 시도
          </Button>
        </DialogFooter>
      </div>
    )
  }
  return <EditForm {...form} initial={{ title: issue.data.title, body: issue.data.body }} save={save} />
}

/** body 가 null 이면 본문 칸 없음(로컬 작업) */
function EditForm({ initial, save, busy, setBusy, onDone }: FormProps & { initial: Initial; save(input: UpdateIssueInput): Promise<void> }) {
  const uid = useId()
  // 처음 연 값을 기준으로 고정한다 — 열어 둔 사이 다시 조회해 기준이 바뀌면, 손대지 않은 옛 본문을 "바뀜"으로 보내게 된다
  const [base] = useState(initial)
  const [title, setTitle] = useState(base.title)
  const [body, setBody] = useState(base.body ?? '')
  const [error, setError] = useState<string | null>(null)

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (busy || t === '') return
    // 바뀐 필드만 보낸다 — GitHub 이슈 PATCH 는 충돌 검사가 없어, 안 고친 본문을 보내면 그사이 다른 곳의 수정을 덮어쓴다.
    // 제목은 양쪽 다 trim 해 비교한다(앞뒤 공백만 다른 기존 제목을 바뀐 것으로 보지 않게)
    const input: UpdateIssueInput = {}
    if (t !== base.title.trim()) input.title = t
    if (base.body !== null && body !== base.body) input.body = body
    if (input.title === undefined && input.body === undefined) return onDone()
    setBusy(true)
    setError(null)
    void save(input)
      .then(onDone)
      .catch((err: unknown) => setError(githubErrorMessage(err)))
      .finally(() => setBusy(false))
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor={`${uid}-title`}>제목</Label>
        <Input id={`${uid}-title`} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} maxLength={256} />
      </div>
      {base.body !== null && (
        <div className="grid gap-1">
          <Label htmlFor={`${uid}-body`}>본문</Label>
          <Textarea id={`${uid}-body`} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} rows={10} className="max-h-[50vh] font-mono" />
        </div>
      )}
      <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
        {error ?? ''}
      </p>
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={busy} onClick={onDone}>
          취소
        </Button>
        <Button type="submit" disabled={busy || title.trim() === ''}>
          {busy ? '저장 중…' : '저장'}
        </Button>
      </DialogFooter>
    </form>
  )
}
