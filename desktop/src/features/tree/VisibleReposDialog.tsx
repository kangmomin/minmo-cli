import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useId, useState } from 'react'

import { ApiError } from '@minmo/api-client'
import type { VisibleRepos } from '@minmo/api-client'
import { isOwnerAllSelected, isRepoVisible, toggleOwnerAll, toggleRepo } from '@minmo/core'
import type { GitHubOwner } from '@minmo/core'

import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group'
import { useSessionStore } from '../../store/session'
import { githubErrorMessage, useOwners, useRepos } from './useTree'
import { useSaveVisibleRepos, useVisibleRepos } from './useVisibleRepos'

type Mode = 'all' | 'selected'

export interface VisibleReposDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
}

/** 트리에 보일 저장소 고르기 — 서버에 저장해 원격 CLI 와 공유한다(E15/E16) */
export function VisibleReposDialog({ open, onOpenChange }: VisibleReposDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>표시할 저장소</DialogTitle>
          <DialogDescription>
            트리와 원격 CLI 에 보일 저장소를 고릅니다. 로컬 worktree 가 있는 저장소는 빼도 &quot;숨김&quot; 표시와 함께 보입니다.
          </DialogDescription>
        </DialogHeader>
        {open && <VisibleReposBody onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function VisibleReposBody({ onDone }: { onDone(): void }) {
  const current = useVisibleRepos()
  if (!current.data) {
    return <p className="text-sm text-muted-foreground">{current.isError ? '선택을 불러올 수 없습니다 — 서버 연결 필요' : '불러오는 중…'}</p>
  }
  // 저장 후 재조회로 updatedAt 이 바뀌면 초안을 새로 시작한다
  return <VisibleReposForm key={current.data.updatedAt ?? 'none'} current={current.data} reload={() => void current.refetch()} onDone={onDone} />
}

function VisibleReposForm({ current, reload, onDone }: { current: VisibleRepos; reload(): void; onDone(): void }) {
  const uid = useId()
  const owners = useOwners()
  const save = useSaveVisibleRepos()
  const offline = useSessionStore((s) => s.status === 'offline')
  const [mode, setMode] = useState<Mode>(current.repos === null ? 'all' : 'selected')
  const [sel, setSel] = useState<string[]>(current.repos ?? [])
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function onSave() {
    setError(null)
    try {
      await save.mutateAsync({ repos: mode === 'all' ? null : sel, base: current.updatedAt })
      onDone()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') {
        setError('다른 기기(원격 CLI 등)에서 먼저 바뀌었습니다 — 최신 선택을 다시 불러왔으니 확인 후 다시 저장하세요')
        reload()
      } else {
        setError(`저장 실패 — ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return (
    <div className="grid gap-4">
      <RadioGroup aria-label="표시 방식" value={mode} onValueChange={(v) => setMode(v as Mode)} className="flex gap-4">
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${uid}-all`} value="all" />
          <Label htmlFor={`${uid}-all`}>모든 저장소</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${uid}-selected`} value="selected" />
          <Label htmlFor={`${uid}-selected`}>고른 저장소만</Label>
        </div>
      </RadioGroup>

      {mode === 'selected' && (
        <div className="grid gap-2">
          <Label htmlFor={`${uid}-q`}>저장소 검색</Label>
          <Input id={`${uid}-q`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="이름 일부" spellCheck={false} />
          <div className="max-h-80 overflow-y-auto rounded border p-1" role="group" aria-label="저장소 목록">
            {owners.isLoading && <p className="p-2 text-xs text-muted-foreground">조직 불러오는 중…</p>}
            {owners.isError && <p className="p-2 text-xs text-destructive">{githubErrorMessage(owners.error)}</p>}
            {owners.data?.map((o) => <OwnerGroup key={o.login} owner={o} sel={sel} setSel={setSel} query={query.trim().toLowerCase()} />)}
          </div>
          {sel.length === 0 && (
            <p className="text-xs text-muted-foreground">아무 저장소도 고르지 않았습니다 — 로컬 worktree 가 있는 저장소만 보입니다.</p>
          )}
        </div>
      )}

      {/* live region 은 미리 렌더해 두어야 변화가 읽힌다 */}
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
      {offline && <p className="text-sm text-muted-foreground">서버 미연결 — 선택을 저장할 수 없습니다</p>}
      <DialogFooter>
        <Button onClick={() => void onSave()} disabled={offline || save.isPending}>
          저장
        </Button>
      </DialogFooter>
    </div>
  )
}

function OwnerGroup(props: { owner: GitHubOwner; sel: string[]; setSel(f: (s: string[]) => string[]): void; query: string }) {
  const { owner, sel, setSel, query } = props
  const uid = useId()
  const [open, setOpen] = useState(false)
  // 검색 중에는 모든 조직의 저장소를 불러와 걸러 보여 준다
  const expanded = open || query !== ''
  const repos = useRepos(owner, expanded)
  const all = isOwnerAllSelected(sel, owner.login)
  const shown = (repos.data ?? []).filter((r) => query === '' || r.name.toLowerCase().includes(query))
  if (query !== '' && repos.data && shown.length === 0) return null

  return (
    <div className="py-0.5">
      <div className="flex items-center gap-1">
        <Button size="icon-sm" variant="ghost" aria-label={`${owner.login} 저장소 ${open ? '접기' : '펼치기'}`} aria-expanded={expanded} onClick={() => setOpen(!open)}>
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </Button>
        <input
          id={`${uid}-all`}
          type="checkbox"
          className="size-4 accent-primary"
          checked={all}
          onChange={(e) => setSel((s) => toggleOwnerAll(s, owner.login, e.target.checked))}
        />
        <Label htmlFor={`${uid}-all`} className="font-medium">
          {owner.login} 전체
        </Label>
      </div>
      {expanded && (
        <div className="ml-9 grid gap-0.5">
          {repos.isLoading && <p className="text-xs text-muted-foreground">불러오는 중…</p>}
          {repos.isError && <p className="text-xs text-destructive">{githubErrorMessage(repos.error)}</p>}
          {shown.map((r) => {
            const id = `${uid}-${r.name}`
            return (
              <div key={r.name} className="flex items-center gap-2">
                <input
                  id={id}
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={isRepoVisible(sel, r.owner, r.name)}
                  // 조직 전체를 고른 동안 개별 체크는 의미가 없다
                  disabled={all}
                  onChange={(e) => setSel((s) => toggleRepo(s, r.owner, r.name, e.target.checked))}
                />
                <Label htmlFor={id} className="font-normal">
                  {r.name}
                </Label>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
