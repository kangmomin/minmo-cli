// 파일 탭: worktree 의 파일 트리 + 텍스트 편집기. 이 PC 와 원격 호스트 모두 같은 화면이다(호스트 작업은 useDeps().tauri 가 맡는다).
import { ChevronDownIcon, ChevronRightIcon, FileIcon, FilePlusIcon, FolderIcon, FolderPlusIcon, Link2Icon, PencilIcon, RefreshCwIcon, SaveIcon, Trash2Icon } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { useDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import type { DirEntry } from '../../lib/tauri'
import { cn } from '../../lib/utils'
import { useUiStore } from '../../store/ui'
import { CodeEditor } from './CodeEditor'
import { eolOf, fileDrafts, fileError, joinRel, nameOf, nameProblem, parentOf, withEol } from './fileDrafts'

export interface FilesTabProps {
  /** worktree 경로 */
  root: string
  /** 편집 상태를 구분하는 키(호스트별 이슈 id) */
  scope: string
}

type DirState = { entries: DirEntry[] } | { error: string } | 'loading'
type Selected = { rel: string; kind: DirEntry['kind'] } | null
type Prompt = { kind: 'file' | 'dir'; dir: string } | { kind: 'rename'; rel: string } | null

export function FilesTab({ root, scope }: FilesTabProps) {
  const { tauri } = useDeps()
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['']))
  const [selected, setSelected] = useState<Selected>(null)
  const [openRel, setOpenRel] = useState<string | null>(() => fileDrafts.openFile(scope))
  const [prompt, setPrompt] = useState<Prompt>(null)
  const [confirmDelete, setConfirmDelete] = useState<Selected>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (rel: string) => {
      setDirs((d) => ({ ...d, [rel]: d[rel] && d[rel] !== 'loading' ? d[rel] : 'loading' }))
      try {
        const entries = await tauri.listDir(root, rel)
        setDirs((d) => ({ ...d, [rel]: { entries } }))
      } catch (e) {
        setDirs((d) => ({ ...d, [rel]: { error: fileError(e).message } }))
      }
    },
    [tauri, root],
  )

  useEffect(() => {
    void load('')
  }, [load])

  function openFile(rel: string | null) {
    fileDrafts.setOpenFile(scope, rel)
    setOpenRel(rel)
  }

  function toggle(rel: string) {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(rel)) next.delete(rel)
      else {
        next.add(rel)
        void load(rel)
      }
      return next
    })
  }

  const refresh = () => Promise.all([...expanded].map((rel) => load(rel)))

  /** 새 항목을 만들 폴더: 고른 폴더, 고른 파일의 폴더, 없으면 최상위 */
  const targetDir = selected === null ? '' : selected.kind === 'dir' ? selected.rel : parentOf(selected.rel)

  async function run(action: () => Promise<void>, done: string) {
    setError(null)
    try {
      await action()
      setStatus(done)
    } catch (e) {
      setError(fileError(e).message)
    }
  }

  async function submitPrompt(name: string) {
    if (!prompt) return
    const p = prompt
    if (p.kind === 'rename') {
      const to = joinRel(parentOf(p.rel), name)
      if (to === p.rel) return setPrompt(null)
      await run(async () => {
        await tauri.renamePath(root, p.rel, to)
        fileDrafts.move(scope, p.rel, to)
        if (openRel !== null && (openRel === p.rel || openRel.startsWith(`${p.rel}/`))) openFile(to + openRel.slice(p.rel.length))
        setSelected((s) => (s && s.rel === p.rel ? { ...s, rel: to } : s))
        await load(parentOf(p.rel))
      }, `${nameOf(p.rel)} → ${name}`)
    } else {
      const rel = joinRel(p.dir, name)
      await run(async () => {
        if (p.kind === 'dir') await tauri.createDir(root, rel)
        else await tauri.writeTextFile(root, rel, '', { create: true })
        setExpanded((s) => new Set(s).add(p.dir))
        await load(p.dir)
        if (p.kind === 'file') {
          setSelected({ rel, kind: 'file' })
          openFile(rel)
        }
      }, `${name} 을(를) 만들었습니다`)
    }
    setPrompt(null)
  }

  async function removeSelected(target: NonNullable<Selected>) {
    await run(async () => {
      await tauri.removePath(root, target.rel)
      fileDrafts.move(scope, target.rel, null)
      if (openRel !== null && (openRel === target.rel || openRel.startsWith(`${target.rel}/`))) openFile(null)
      setSelected(null)
      await load(parentOf(target.rel))
    }, `${nameOf(target.rel)} 을(를) 삭제했습니다`)
    setConfirmDelete(null)
  }

  return (
    <div className="absolute inset-0 flex" data-testid="files-tab">
      <div className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex items-center gap-0.5 border-b px-1 py-1">
          <Button size="icon-sm" variant="ghost" aria-label="새 파일" title="새 파일" onClick={() => setPrompt({ kind: 'file', dir: targetDir })}>
            <FilePlusIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="새 폴더" title="새 폴더" onClick={() => setPrompt({ kind: 'dir', dir: targetDir })}>
            <FolderPlusIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="이름 바꾸기" title="이름 바꾸기" disabled={!selected} onClick={() => selected && setPrompt({ kind: 'rename', rel: selected.rel })}>
            <PencilIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="삭제" title="삭제" disabled={!selected} onClick={() => setConfirmDelete(selected)}>
            <Trash2Icon />
          </Button>
          <span className="flex-1" />
          <Button size="icon-sm" variant="ghost" aria-label="파일 목록 새로고침" title="새로고침" onClick={() => void refresh()}>
            <RefreshCwIcon />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1" role="tree" aria-label="파일">
          <DirRows rel="" depth={0} dirs={dirs} expanded={expanded} selected={selected} openRel={openRel} onToggle={toggle} onSelect={setSelected} onOpen={openFile} />
        </div>
        {/* 결과 안내: live region 은 미리 렌더해 둔다 */}
        <p role="status" className="truncate border-t px-2 py-1 text-xs text-muted-foreground">
          {status}
        </p>
        {error && (
          <p role="alert" className="border-t px-2 py-1 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>

      <div className="relative min-w-0 flex-1">
        {openRel === null ? (
          <p className="p-4 text-sm text-muted-foreground">왼쪽에서 파일을 고르면 여기서 편집합니다.</p>
        ) : (
          <FileEditor key={openRel} root={root} scope={scope} rel={openRel} />
        )}
      </div>

      {prompt && <NamePrompt prompt={prompt} onSubmit={submitPrompt} onCancel={() => setPrompt(null)} />}
      {confirmDelete && (
        <Dialog open onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>삭제</DialogTitle>
              <DialogDescription>
                <code className="font-mono">{confirmDelete.rel}</code> {confirmDelete.kind === 'dir' ? '폴더와 그 안의 모든 파일을' : '을(를)'} 삭제합니다. 되돌릴 수 없습니다.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                취소
              </Button>
              <Button variant="destructive" onClick={() => void removeSelected(confirmDelete)}>
                삭제
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

interface DirRowsProps {
  rel: string
  depth: number
  dirs: Record<string, DirState>
  expanded: ReadonlySet<string>
  selected: Selected
  openRel: string | null
  onToggle(rel: string): void
  onSelect(s: Selected): void
  onOpen(rel: string): void
}

function DirRows(p: DirRowsProps) {
  const state = p.dirs[p.rel]
  const pad = { paddingLeft: `${p.depth * 12 + 4}px` }
  if (state === undefined || state === 'loading') {
    return (
      <p className="py-0.5 text-xs text-muted-foreground" style={pad}>
        불러오는 중…
      </p>
    )
  }
  if ('error' in state) {
    return (
      <p className="py-0.5 text-xs text-destructive" style={pad}>
        {state.error}
      </p>
    )
  }
  if (state.entries.length === 0) {
    return (
      <p className="py-0.5 text-xs text-muted-foreground" style={pad}>
        비어 있음
      </p>
    )
  }
  return (
    <>
      {state.entries.map((e) => {
        const rel = joinRel(p.rel, e.name)
        const isDir = e.kind === 'dir'
        const open = isDir && p.expanded.has(rel)
        const isSelected = p.selected?.rel === rel
        return (
          <div key={rel} role="none">
            <button
              type="button"
              role="treeitem"
              aria-expanded={isDir ? open : undefined}
              aria-selected={isSelected}
              data-testid={`file-row-${rel}`}
              style={pad}
              title={e.kind === 'link' ? `${rel} (심볼릭 링크)` : rel}
              className={cn('flex w-full items-center gap-1 rounded py-0.5 pr-1 text-left text-sm hover:bg-accent', isSelected && 'bg-accent', p.openRel === rel && 'font-medium')}
              onClick={() => {
                p.onSelect({ rel, kind: e.kind })
                if (isDir) p.onToggle(rel)
                else if (e.kind === 'file') p.onOpen(rel)
              }}
            >
              {isDir ? open ? <ChevronDownIcon className="size-3.5 shrink-0" /> : <ChevronRightIcon className="size-3.5 shrink-0" /> : <span className="w-3.5 shrink-0" />}
              {isDir ? (
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : e.kind === 'link' ? (
                <Link2Icon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{e.name}</span>
            </button>
            {open && <DirRows {...p} rel={rel} depth={p.depth + 1} />}
          </div>
        )
      })}
    </>
  )
}

function NamePrompt({ prompt, onSubmit, onCancel }: { prompt: NonNullable<Prompt>; onSubmit(name: string): Promise<void>; onCancel(): void }) {
  const uid = useId()
  const [name, setName] = useState(prompt.kind === 'rename' ? nameOf(prompt.rel) : '')
  const [problem, setProblem] = useState<string | null>(null)
  const title = prompt.kind === 'rename' ? '이름 바꾸기' : prompt.kind === 'dir' ? '새 폴더' : '새 파일'
  const where = prompt.kind === 'rename' ? parentOf(prompt.rel) : prompt.dir

  function submit(e: FormEvent) {
    e.preventDefault()
    const p = nameProblem(name)
    setProblem(p)
    if (p === null) void onSubmit(name.trim())
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>위치: {where === '' ? '(최상위)' : where}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-2">
          <Label htmlFor={`${uid}-name`}>이름</Label>
          <Input id={`${uid}-name`} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} autoFocus aria-invalid={problem !== null} />
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>
              취소
            </Button>
            <Button type="submit">확인</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

type Loaded = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready' }

/** 파일 하나의 편집기. 편집 상태는 fileDrafts 에 두어 탭·이슈를 오가도 유지된다 */
function FileEditor({ root, scope, rel }: { root: string; scope: string; rel: string }) {
  const { tauri } = useDeps()
  const dark = useUiStore((s) => s.theme === 'black')
  const [loaded, setLoaded] = useState<Loaded>(() => (fileDrafts.get(scope, rel) ? { state: 'ready' } : { state: 'loading' }))
  const [dirty, setDirty] = useState(() => {
    const d = fileDrafts.get(scope, rel)
    return d ? d.text !== d.saved : false
  })
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState<{ message: string; conflict: boolean } | null>(null)
  /** 내용을 다시 넣어야 할 때(다시 불러오기) 편집기를 새로 만든다 */
  const [generation, setGeneration] = useState(0)
  const saveRef = useRef<() => void>(() => {})

  const read = useCallback(async () => {
    setLoaded({ state: 'loading' })
    setProblem(null)
    try {
      const f = await tauri.readTextFile(root, rel)
      fileDrafts.set(scope, rel, { text: f.content, saved: f.content, version: f.version })
      setDirty(false)
      setLoaded({ state: 'ready' })
      setGeneration((g) => g + 1)
    } catch (e) {
      setLoaded({ state: 'error', message: fileError(e).message })
    }
  }, [tauri, root, scope, rel])

  // 저장 안 한 내용이 없으면 열 때마다 다시 읽는다 — 터미널·에이전트가 바꾼 내용을 보여 주기 위해.
  // 저장 안 한 내용이 있으면 그대로 두고, 그 사이 파일이 바뀌었는지는 저장할 때 확인한다
  useEffect(() => {
    const d = fileDrafts.get(scope, rel)
    if (!d || d.text === d.saved) void read()
  }, [read, scope, rel])

  async function save(overwrite = false) {
    const d = fileDrafts.get(scope, rel)
    if (!d || saving) return
    setSaving(true)
    setProblem(null)
    try {
      const text = d.text
      const version = await tauri.writeTextFile(root, rel, text, overwrite ? undefined : { expected: d.version })
      // 저장하는 동안 더 입력했을 수 있다 — 방금 저장한 내용만 "저장됨" 으로 본다
      const now = fileDrafts.get(scope, rel) ?? d
      fileDrafts.set(scope, rel, { text: now.text, saved: text, version })
      setDirty(now.text !== text)
      setNotice('저장했습니다')
    } catch (e) {
      const err = fileError(e)
      setProblem({ message: err.message, conflict: err.code === 'file_changed' })
    } finally {
      setSaving(false)
    }
  }
  useEffect(() => {
    saveRef.current = () => void save()
  })

  const draft = fileDrafts.get(scope, rel)
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={rel}>
          {rel}
          {dirty && <span className="ml-2 text-amber-600 dark:text-amber-400">● 저장 안 됨</span>}
        </span>
        <span role="status" className="text-xs text-muted-foreground">
          {notice}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void read()} disabled={saving}>
          {dirty ? '변경 버리고 다시 불러오기' : '다시 불러오기'}
        </Button>
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          <SaveIcon /> 저장
        </Button>
      </div>
      {problem && (
        <div role="alert" className="flex flex-wrap items-center gap-2 bg-destructive/10 px-3 py-1.5 text-sm text-destructive">
          <span className="flex-1">{problem.conflict ? '이 파일이 다른 곳에서 바뀌었습니다. 다시 불러오면 여기서 고친 내용을 잃습니다.' : `저장하지 못했습니다: ${problem.message}`}</span>
          {problem.conflict && (
            <Button size="sm" variant="outline" onClick={() => void save(true)}>
              내 내용으로 덮어쓰기
            </Button>
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {loaded.state === 'loading' && <p className="p-4 text-sm text-muted-foreground">불러오는 중…</p>}
        {loaded.state === 'error' && (
          <p role="alert" className="p-4 text-sm text-destructive">
            열 수 없습니다: {loaded.message}
          </p>
        )}
        {loaded.state === 'ready' && draft && (
          <CodeEditor
            key={generation}
            initial={draft.text}
            fileName={nameOf(rel)}
            dark={dark}
            label={`${rel} 편집`}
            onChange={(edited) => {
              const d = fileDrafts.get(scope, rel)
              if (!d) return
              // 편집기가 \n 으로 바꾼 줄바꿈을 파일의 원래 방식(CRLF 등)으로 되돌린다 — 안 그러면 저장할 때 파일 전체가 바뀐다
              const text = withEol(edited, eolOf(d.saved))
              fileDrafts.set(scope, rel, { ...d, text })
              setDirty(text !== d.saved)
              setNotice('')
            }}
            onSave={() => saveRef.current()}
          />
        )}
      </div>
    </div>
  )
}
