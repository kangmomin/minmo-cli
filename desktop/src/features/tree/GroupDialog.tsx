import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useId, useState } from 'react'

import type { GitHubOwner } from '@minmo/core'

import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { LOCAL_OWNER, clampNickname, repoKey, repoLabelOf, splitFullName, useReposStore } from '../../store/repos'
import { githubErrorMessage, useOwners, useRepos } from './useTree'

export interface GroupDialogProps {
  /** 고칠 그룹 id. null 이면 새 그룹 */
  id: string | null
  open: boolean
  onOpenChange(open: boolean): void
  /** 새 그룹을 저장했을 때 그 id */
  onCreated?(id: string): void
}

/** 사용자 정의 그룹 만들기·고치기·지우기(#105) — 이름과 묶을 저장소를 고른다 */
export function GroupDialog({ id, open, onOpenChange, onCreated }: GroupDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{id === null ? '그룹 만들기' : '그룹 편집'}</DialogTitle>
          <DialogDescription>여러 조직의 저장소를 이름을 붙여 묶습니다. 묶은 저장소만 보이는 새 창을 열 수 있습니다.</DialogDescription>
        </DialogHeader>
        {open && <GroupForm id={id} onDone={() => onOpenChange(false)} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  )
}

/** 고른 저장소를 대소문자 없이 다룬다("owner/name" 표기는 처음 고른 그대로 둔다) */
type Toggle = (full: string, on: boolean) => void
const has = (sel: string[], full: string) => sel.some((s) => s.toLowerCase() === full.toLowerCase())

function GroupForm({ id, onDone, onCreated }: { id: string | null; onDone(): void; onCreated?(id: string): void }) {
  const uid = useId()
  const existing = useReposStore((s) => (id === null ? undefined : s.groups[id]))
  const local = useReposStore((s) => s.local)
  const nicknames = useReposStore((s) => s.nicknames)
  const added = useReposStore((s) => s.added)
  const owners = useOwners()
  const [name, setName] = useState(existing?.name ?? '')
  const [sel, setSel] = useState<string[]>(existing?.repos ?? [])
  const [query, setQuery] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const q = query.trim().toLowerCase()
  const labelOf = (full: string) => {
    const [o, r] = splitFullName(full)
    return o === LOCAL_OWNER ? repoLabelOf({ local, nicknames }, o, r) : full
  }
  const toggle: Toggle = (full, on) => setSel((s) => (on ? (has(s, full) ? s : [...s, full]) : s.filter((x) => x.toLowerCase() !== full.toLowerCase())))
  const matches = (full: string) => q === '' || [full, labelOf(full), nicknames[repoKey(...splitFullName(full))] ?? ''].some((n) => n.toLowerCase().includes(q))
  const localRepos = Object.keys(local).map((rid) => `${LOCAL_OWNER}/${rid}`)
  // 내 계정·조직 목록에 없는 소유자의, 직접 추가한 저장소
  const foreign = added.filter((full) => !owners.data?.some((o) => o.login.toLowerCase() === splitFullName(full)[0].toLowerCase()))
  const trimmed = name.trim()

  function onSave() {
    const saved = useReposStore.getState().saveGroup(id, { name: trimmed, repos: sel })
    if (saved === null) return
    if (id === null) onCreated?.(saved)
    onDone()
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor={`${uid}-name`}>그룹 이름</Label>
        <Input id={`${uid}-name`} value={name} onChange={(e) => setName(clampNickname(e.target.value))} placeholder="예: 백엔드" />
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${uid}-q`}>저장소 검색</Label>
        <Input id={`${uid}-q`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="이름·별칭 일부" spellCheck={false} />
        <div className="max-h-80 overflow-y-auto rounded border p-1" role="group" aria-label="그룹에 넣을 저장소">
          {sel.length > 0 && q === '' && (
            <PickSection title={`고른 저장소 (${sel.length})`} items={sel} sel={sel} toggle={toggle} labelOf={labelOf} />
          )}
          {localRepos.some(matches) && <PickSection title="로컬 저장소" items={localRepos.filter(matches)} sel={sel} toggle={toggle} labelOf={labelOf} />}
          {owners.isLoading && <p className="p-2 text-xs text-muted-foreground">조직 불러오는 중…</p>}
          {owners.isError && <p className="p-2 text-xs text-destructive">{githubErrorMessage(owners.error)}</p>}
          {owners.data?.map((o) => <OwnerPicker key={o.login} owner={o} sel={sel} toggle={toggle} query={q} />)}
          {foreign.some(matches) && <PickSection title="직접 추가한 저장소" items={foreign.filter(matches)} sel={sel} toggle={toggle} labelOf={labelOf} />}
        </div>
      </div>

      <DialogFooter className="gap-2 sm:justify-between">
        {id !== null ? (
          confirmRemove ? (
            <Button
              variant="destructive"
              onClick={() => {
                useReposStore.getState().removeGroup(id)
                onDone()
              }}
            >
              정말 삭제
            </Button>
          ) : (
            // 저장소·설정은 지우지 않는다 — 그래도 한 번 더 누르게 해 실수로 지우지 않게 한다
            <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
              그룹 삭제
            </Button>
          )
        ) : (
          <span />
        )}
        <Button onClick={onSave} disabled={trimmed === ''}>
          저장
        </Button>
      </DialogFooter>
    </div>
  )
}

function PickSection(props: { title: string; items: string[]; sel: string[]; toggle: Toggle; labelOf(full: string): string }) {
  return (
    <div className="py-0.5">
      <p className="px-1 py-0.5 text-xs font-medium text-muted-foreground">{props.title}</p>
      <div className="ml-3 grid gap-0.5">
        {props.items.map((full) => (
          <PickRow key={full} full={full} label={props.labelOf(full)} checked={has(props.sel, full)} toggle={props.toggle} />
        ))}
      </div>
    </div>
  )
}

function PickRow({ full, label, checked, toggle }: { full: string; label: string; checked: boolean; toggle: Toggle }) {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <input id={id} type="checkbox" className="size-4 accent-primary" checked={checked} onChange={(e) => toggle(full, e.target.checked)} />
      <Label htmlFor={id} className="font-normal" title={full}>
        {label}
      </Label>
    </div>
  )
}

/** 조직 하나의 저장소 — 펼치거나 검색할 때만 불러온다 */
function OwnerPicker({ owner, sel, toggle, query }: { owner: GitHubOwner; sel: string[]; toggle: Toggle; query: string }) {
  const [open, setOpen] = useState(false)
  const expanded = open || query !== ''
  const repos = useRepos(owner, expanded)
  const nicknames = useReposStore((s) => s.nicknames)
  const shown = (repos.data ?? []).filter((r) => query === '' || [r.name, nicknames[repoKey(r.owner, r.name)] ?? ''].some((n) => n.toLowerCase().includes(query)))
  if (query !== '' && repos.data && shown.length === 0) return null

  return (
    <div className="py-0.5">
      <div className="flex items-center gap-1">
        <Button size="icon-sm" variant="ghost" aria-label={`${owner.login} 저장소 ${expanded ? '접기' : '펼치기'}`} aria-expanded={expanded} onClick={() => setOpen(!open)}>
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </Button>
        <span className="text-sm font-medium">{owner.login}</span>
      </div>
      {expanded && (
        <div className="ml-9 grid gap-0.5">
          {repos.isLoading && <p className="text-xs text-muted-foreground">불러오는 중…</p>}
          {repos.isError && <p className="text-xs text-destructive">{githubErrorMessage(repos.error)}</p>}
          {shown.map((r) => {
            const full = `${r.owner}/${r.name}`
            return <PickRow key={r.name} full={full} label={nicknames[repoKey(r.owner, r.name)] ?? r.name} checked={has(sel, full)} toggle={toggle} />
          })}
        </div>
      )}
    </div>
  )
}
