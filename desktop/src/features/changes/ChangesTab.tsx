import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLinkIcon, GitCommitIcon, GitPullRequestIcon, RefreshCwIcon, UploadIcon } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { useDeps } from '../../app/deps'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { GitHubError, lacksOrigin } from '@minmo/core'
import { queryKeys } from '../../lib/queryKeys'
import { cn } from '../../lib/utils'
import { isLocalOwner } from '../../store/repos'
import { GitError, buildPrDraft, useGit } from './useGit'
import type { FileChange, GitErrorCode, PrResult, UseGitTarget } from './useGit'

type Feedback = { kind: 'ok' | 'error'; text: string; detail?: string } | null

const GIT_ERROR_TITLE: Record<GitErrorCode, string> = {
  push_rejected: 'push 거절됨 — 원격이 앞서 있습니다(강제 push 하지 않음)',
  permission_denied: '권한 없음 — 이 저장소에 쓰기 권한이 없습니다',
  title_required: 'PR 제목을 입력하세요',
  nothing_selected: '커밋할 파일을 선택하세요',
  git_failed: 'git 실패',
}

function errorFeedback(e: unknown): Feedback {
  if (e instanceof GitError) return { kind: 'error', text: GIT_ERROR_TITLE[e.code], detail: e.stderr ?? e.message }
  if (e instanceof GitHubError) {
    if (e.code === 'rate_limited') {
      return { kind: 'error', text: e.retryAt ? `GitHub 사용량 제한 — ${e.retryAt.toLocaleTimeString()} 이후 재시도` : 'GitHub 사용량 제한 — 잠시 후 재시도' }
    }
    return { kind: 'error', text: `GitHub 오류(${e.code})`, detail: e.message }
  }
  return { kind: 'error', text: e instanceof Error ? e.message : String(e) }
}

const statusLabel = (f: FileChange) => (f.untracked ? '새 파일' : f.xy.replace(/\./g, ' ').trim() || f.xy)

/** 변경 탭 (F-05): 파일 선택 → 커밋 → push → PR */
export interface ChangesTabProps {
  target: UseGitTarget
}

export function ChangesTab({ target }: ChangesTabProps) {
  const { tauri } = useDeps()
  const queryClient = useQueryClient()
  const git = useGit(target)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [busy, setBusy] = useState<null | 'commit' | 'push' | 'pr'>(null)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [prOpen, setPrOpen] = useState(false)
  const [pr, setPr] = useState<PrResult | null>(null)
  const msgId = useId()
  // 로컬 저장소(GitHub 아님)에는 PR 이 없고, origin 이 없으면 push 할 곳도 없다
  const local = isLocalOwner(target.owner)
  const noOrigin =
    useQuery({ queryKey: queryKeys.gitOrigin(target.cwd), queryFn: () => lacksOrigin(tauri.gitRun, target.cwd), enabled: local }).data === true

  // 사라진 파일은 선택에서 뺀다
  const paths = git.changes.map((c) => c.path).join('\n')
  useEffect(() => {
    const present = new Set(paths.split('\n'))
    setSelected((s) => {
      const next = new Set([...s].filter((p) => present.has(p)))
      return next.size === s.size ? s : next
    })
  }, [paths])

  // 선택 파일의 상태값만 의존한다 — 5초 폴링·다른 파일 변화로 목록 배열이 바뀌어도 diff 를 다시 부르지 않는다(CR-04)
  const selectedChange = diffPath ? git.changes.find((c) => c.path === diffPath) : undefined
  const selPresent = selectedChange !== undefined
  const selUntracked = selectedChange?.untracked ?? false
  const selStaged = selectedChange?.staged ?? false
  const selUnstaged = selectedChange?.unstaged ?? false
  // 커밋 등으로 선택 파일이 목록에서 사라지면 선택·diff 를 해제한다 — 옛 diff 가 남지 않도록(CR-09)
  useEffect(() => {
    if (diffPath !== null && !selPresent) {
      setDiffPath(null)
      setDiff('')
    }
  }, [diffPath, selPresent])
  useEffect(() => {
    if (!diffPath || !selPresent) return
    let cancelled = false
    // 이전 파일의 diff 가 새 경로 아래 남아 보이지 않도록 로딩 표시부터
    setDiff('불러오는 중…')
    const load = selUntracked
      ? Promise.resolve('(새 파일 — 커밋하면 추가됩니다)')
      : git.ops.diff(target.cwd, diffPath, { staged: selStaged && !selUnstaged })
    void load
      .then((d) => !cancelled && setDiff(d || '(차이 없음)'))
      .catch((e: unknown) => !cancelled && setDiff(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [diffPath, selPresent, selUntracked, selStaged, selUnstaged, git.ops, target.cwd])

  const refreshGit = () => queryClient.invalidateQueries({ queryKey: queryKeys.gitAll })

  // 커밋·push·PR 공통: 진행 표시 + 실패 문구
  async function run(kind: 'commit' | 'push' | 'pr', fn: () => Promise<void>) {
    setBusy(kind)
    setFeedback(null)
    try {
      await fn()
    } catch (e) {
      setFeedback(errorFeedback(e))
    } finally {
      setBusy(null)
    }
  }

  const commit = () =>
    run('commit', async () => {
      const { hash } = await git.ops.commit(target.cwd, [...selected], message.trim())
      setFeedback({ kind: 'ok', text: `커밋 ${hash.slice(0, 7)}` })
      setMessage('')
      setSelected(new Set())
      await refreshGit()
    })

  const push = () =>
    run('push', async () => {
      await git.ops.push(target.cwd, target.branch)
      setFeedback({ kind: 'ok', text: `push 완료 — origin/${target.branch}` })
      await refreshGit()
    })

  const allSelected = git.changes.length > 0 && selected.size === git.changes.length

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3" data-testid="changes-tab">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">변경 {git.changes.length}개</span>
        <Badge variant={git.unpushed > 0 ? 'default' : 'secondary'} title={noOrigin ? '다른 브랜치에 없는 커밋 수(origin 원격 없음)' : 'origin 에 없는 커밋 수'}>
          미push {git.unpushed}
        </Badge>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" aria-label="변경 새로고침" onClick={() => void git.refresh()}>
          <RefreshCwIcon />
        </Button>
        {!noOrigin && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void push()}>
            <UploadIcon /> push
          </Button>
        )}
        {!local && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setPrOpen(true)}>
            <GitPullRequestIcon /> PR
          </Button>
        )}
      </div>

      {/* 성공은 polite(status) — 컨테이너를 항상 두어야 스크린 리더가 내용 변화를 읽는다. 실패는 즉시(alert) */}
      <div role="status" className="empty:sr-only">
        {feedback?.kind === 'ok' && <div className="rounded bg-emerald-50 p-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">{feedback.text}</div>}
      </div>
      {feedback?.kind === 'error' && (
        <div role="alert" className="rounded bg-destructive/10 p-2 text-sm text-destructive">
          {feedback.text}
          {feedback.detail && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-xs">{feedback.detail}</pre>}
        </div>
      )}
      {pr && (
        <div className="flex items-center gap-2 rounded bg-muted p-2 text-sm">
          <span>{pr.existing ? '이미 열린 PR' : 'PR 생성됨'} #{pr.number}</span>
          <a className="truncate text-primary underline" href={pr.url} onClick={(e) => {
              e.preventDefault()
              void tauri.openUrl(pr.url)
            }}
          >
            {pr.url}
          </a>
          <ExternalLinkIcon className="size-3.5" />
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(14rem,1fr)_2fr] gap-2">
        <div className="flex min-h-0 flex-col rounded border">
          <label className="flex items-center gap-2 border-b px-2 py-1 text-xs">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => setSelected(e.target.checked ? new Set(git.changes.map((c) => c.path)) : new Set())}
            />
            전체 선택
          </label>
          <ul className="min-h-0 flex-1 overflow-auto text-sm">
            {git.isLoading && <li className="p-2 text-xs text-muted-foreground">불러오는 중…</li>}
            {git.error !== null && git.error !== undefined && (
              <li className="whitespace-pre-wrap p-2 text-xs text-destructive">
                변경 사항을 불러오지 못했습니다 — {git.error instanceof Error ? git.error.message : String(git.error)}
              </li>
            )}
            {!git.isLoading && !git.error && git.changes.length === 0 && <li className="p-2 text-xs text-muted-foreground">변경 없음</li>}
            {git.changes.map((c) => (
              <li key={c.path} className={cn('flex items-center gap-2 px-2 py-0.5 hover:bg-accent', diffPath === c.path && 'bg-accent')}>
                <input
                  type="checkbox"
                  aria-label={`${c.path} 선택`}
                  checked={selected.has(c.path)}
                  onChange={(e) =>
                    setSelected((s) => {
                      const next = new Set(s)
                      if (e.target.checked) next.add(c.path)
                      else next.delete(c.path)
                      return next
                    })
                  }
                />
                <button type="button" className="min-w-0 flex-1 truncate text-left font-mono text-xs" onClick={() => setDiffPath(c.path)} title={c.origPath ? `${c.origPath} → ${c.path}` : c.path}>
                  {c.path}
                </button>
                <span className="text-[10px] text-muted-foreground">{statusLabel(c)}</span>
              </li>
            ))}
          </ul>
        </div>
        <pre className="min-h-0 overflow-auto rounded border bg-muted/40 p-2 font-mono text-xs" aria-label="diff">
          {diffPath ? diff : '파일을 선택하면 diff 를 표시합니다'}
        </pre>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={msgId}>커밋 메시지</Label>
        <div className="flex gap-2">
          <Textarea id={msgId} rows={2} value={message} onChange={(e) => setMessage(e.target.value)} className="flex-1" />
          <Button disabled={busy !== null || selected.size === 0 || message.trim() === ''} onClick={() => void commit()}>
            <GitCommitIcon /> 커밋
          </Button>
        </div>
      </div>

      <PrDialog
        open={prOpen}
        onOpenChange={setPrOpen}
        target={target}
        onCreate={(input) =>
          run('pr', async () => {
            try {
              const res = await git.ops.createOrOpenPr({ owner: target.owner, repo: target.repo, branch: target.branch, issue: target.issue, ...input })
              setPr(res)
              void tauri.openUrl(res.url)
            } finally {
              setPrOpen(false)
            }
          })
        }
      />
    </div>
  )
}

function PrDialog(props: {
  open: boolean
  onOpenChange(o: boolean): void
  target: UseGitTarget
  onCreate(input: { title: string; body: string; draft: boolean }): Promise<void>
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pull Request</DialogTitle>
          <DialogDescription>
            {props.target.branch} → 기본 브랜치. 이미 열린 PR 이 있으면 그 PR 을 엽니다.
          </DialogDescription>
        </DialogHeader>
        {props.open && <PrForm {...props} />}
      </DialogContent>
    </Dialog>
  )
}

function PrForm({ target, onCreate }: { target: UseGitTarget; onCreate(input: { title: string; body: string; draft: boolean }): Promise<void> }) {
  const draft0 = buildPrDraft(target.issue)
  const [title, setTitle] = useState(draft0.title)
  const [body, setBody] = useState(draft0.body)
  const [draft, setDraft] = useState(draft0.draft)
  const [pending, setPending] = useState(false)
  const tId = useId()
  const bId = useId()
  const titleMissing = draft0.titleRequired && title.trim() === ''
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        setPending(true)
        void onCreate({ title, body, draft }).finally(() => setPending(false))
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={tId}>제목{draft0.titleRequired && ' (필수)'}</Label>
        <Input id={tId} value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={titleMissing || undefined} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={bId}>본문</Label>
        <Textarea id={bId} rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
        draft 로 생성
      </label>
      <DialogFooter>
        <Button type="submit" disabled={pending || titleMissing}>
          PR 만들기
        </Button>
      </DialogFooter>
    </form>
  )
}
