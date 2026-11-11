// 로컬 저장소(GitHub 가 아닌 폴더)의 대화상자 — 작업 추가, GitHub 에 올리기.
import { useQueryClient } from '@tanstack/react-query'
import { CheckIcon, Loader2Icon } from 'lucide-react'
import { useId, useState } from 'react'
import type { FormEvent } from 'react'

import { useDeps } from '../../app/deps'
import { useHost } from '../../app/host'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { queryKeys } from '../../lib/queryKeys'
import { useReposStore } from '../../store/repos'
import { useSessionStore } from '../../store/session'
import { PUBLISH_STEPS, PUBLISH_STEP_LABEL, PublishError, githubNameOf, publishRepo } from './publishRepo'
import type { PublishStep } from './publishRepo'
import { useOwners } from './useTree'

export interface LocalRepoDialogProps {
  /** 로컬 저장소 id */
  id: string
  open: boolean
  onOpenChange(open: boolean): void
}

/** 작업 추가 — GitHub 이슈 대신 쓰는 앱 안의 작업 단위. 번호는 1부터 차례로 붙는다 */
export function NewTaskDialog({ id, open, onOpenChange }: LocalRepoDialogProps) {
  const name = useReposStore((s) => s.local[id]?.displayName ?? id)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>작업 추가 — {name}</DialogTitle>
          <DialogDescription>작업마다 브랜치와 작업 폴더(worktree)를 따로 씁니다. 제목은 브랜치 이름에 쓰입니다.</DialogDescription>
        </DialogHeader>
        {open && <NewTaskBody id={id} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function NewTaskBody({ id, onDone }: { id: string; onDone(): void }) {
  const uid = useId()
  const [title, setTitle] = useState('')
  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (title.trim() === '') return
    useReposStore.getState().addTask(id, title.trim())
    onDone()
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor={`${uid}-title`}>제목</Label>
        <Input id={`${uid}-title`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="로그인 화면 만들기" maxLength={200} />
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          취소
        </Button>
        <Button type="submit" disabled={title.trim() === ''}>
          추가
        </Button>
      </DialogFooter>
    </form>
  )
}

export function PublishDialog({ id, open, onOpenChange }: LocalRepoDialogProps) {
  const name = useReposStore((s) => s.local[id]?.displayName ?? id)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>GitHub 에 올리기 — {name}</DialogTitle>
          <DialogDescription>
            새 GitHub 저장소를 만들어 모든 브랜치를 push 하고, 이 항목을 GitHub 저장소로 바꿉니다. 앱 안의 작업은 같은 번호의 GitHub 이슈로 만들어지고 메모·프로젝트 설정도 옮겨집니다.
          </DialogDescription>
        </DialogHeader>
        {open && <PublishBody id={id} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function PublishBody({ id, onDone }: { id: string; onDone(): void }) {
  const uid = useId()
  const host = useHost()
  const { tauri, github, api } = useDeps()
  const queryClient = useQueryClient()
  const online = useSessionStore((s) => s.status === 'online')
  const owners = useOwners()
  // 올리는 도중 항목이 로컬 목록에서 빠지므로(전환) 처음 값을 잡아 둔다
  const [local] = useState(() => useReposStore.getState().local[id])
  const resume = local?.publish
  const [owner, setOwner] = useState(resume?.owner ?? '')
  const [name, setName] = useState(resume?.name ?? githubNameOf(local?.displayName ?? ''))
  const [isPrivate, setPrivate] = useState(resume?.private ?? true)
  const [step, setStep] = useState<PublishStep | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const ownerList = owners.data ?? []
  const chosen = owner || ownerList[0]?.login || ''
  const taskCount = local?.tasks.length ?? 0

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const isOrg = ownerList.find((o) => o.login === chosen)?.kind === 'org'
    void publishRepo({ tauri, github, api }, host, { id, owner: chosen, isOrg, name: name.trim(), private: isPrivate }, setStep)
      .then(async (repo) => {
        setDone(`${repo.owner}/${repo.name}`)
        await queryClient.invalidateQueries({ queryKey: queryKeys.githubAll })
      })
      .catch((err) => setError(err instanceof PublishError ? `${PUBLISH_STEP_LABEL[err.step]} 단계에서 멈췄습니다: ${err.message}` : String(err)))
      .finally(() => setBusy(false))
  }

  if (done) {
    return (
      <div className="grid gap-3">
        <p role="status" className="text-sm">
          <strong>{done}</strong> 로 올렸습니다. 트리의 소유자 아래에서 GitHub 저장소로 보입니다. 열려 있던 터미널은 닫혔으니 이슈를 다시 여세요.
        </p>
        <DialogFooter>
          <Button onClick={onDone}>확인</Button>
        </DialogFooter>
      </div>
    )
  }

  const started = step !== null
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor={`${uid}-owner`}>소유자</Label>
        <select
          id={`${uid}-owner`}
          className="h-9 rounded border bg-background px-2 text-sm"
          value={chosen}
          disabled={busy || !!resume || started}
          onChange={(e) => setOwner(e.target.value)}
        >
          {resume && !ownerList.some((o) => o.login === resume.owner) && <option value={resume.owner}>{resume.owner}</option>}
          {ownerList.map((o) => (
            <option key={o.login} value={o.login}>
              {o.login}
              {o.kind === 'org' ? ' (조직)' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${uid}-name`}>저장소 이름</Label>
        <Input id={`${uid}-name`} value={name} onChange={(e) => setName(e.target.value)} disabled={busy || !!resume || started} spellCheck={false} className="font-mono" />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isPrivate} disabled={busy || !!resume || started} onChange={(e) => setPrivate(e.target.checked)} />
        비공개 저장소
      </label>
      <p className="text-xs text-muted-foreground">
        {taskCount > 0 ? `작업 ${taskCount}개가 GitHub 이슈로 만들어집니다(닫은 작업은 닫힌 이슈). ` : ''}
        {host.alias === null ? 'push 는 이 PC 의 git 인증을 씁니다.' : `push 는 ${host.label} 에서 이 PC 의 GitHub 토큰으로 합니다.`}
        {resume ? ` 이전에 ${resume.owner}/${resume.name} 로 올리다 멈췄습니다 — 이어서 진행합니다.` : ''}
      </p>
      {started && (
        <ol className="grid gap-1 text-sm" aria-label="진행 단계">
          {PUBLISH_STEPS.map((s) => {
            const at = PUBLISH_STEPS.indexOf(step)
            const i = PUBLISH_STEPS.indexOf(s)
            const state = i < at ? 'done' : i === at ? (error ? 'failed' : 'running') : 'todo'
            return (
              <li key={s} className={state === 'todo' ? 'flex items-center gap-2 text-muted-foreground' : state === 'failed' ? 'flex items-center gap-2 text-destructive' : 'flex items-center gap-2'}>
                {state === 'done' ? <CheckIcon className="size-3.5" /> : state === 'running' ? <Loader2Icon className="size-3.5 animate-spin" /> : <span className="size-3.5" />}
                {PUBLISH_STEP_LABEL[s]}
                {state === 'failed' ? ' — 실패' : ''}
              </li>
            )
          })}
        </ol>
      )}
      <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
        {error ?? (!online ? '서버에 연결되어 있어야 합니다(메모·설정을 옮깁니다).' : '')}
      </p>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          {started ? '닫기' : '취소'}
        </Button>
        <Button type="submit" disabled={busy || !online || chosen === '' || name.trim() === ''}>
          {error || resume ? '이어서 올리기' : '올리기'}
        </Button>
      </DialogFooter>
    </form>
  )
}
