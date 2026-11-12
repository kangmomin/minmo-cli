// 저장소를 트리에 더하는 대화상자 셋 — 새 프로젝트(로컬 폴더), 폴더 열기, GitHub 저장소 추가.
import { FolderOpenIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'

import { GitHubError } from '@minmo/core'

import { useDeps } from '../../app/deps'
import { useHost } from '../../app/host'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { LOCAL_OWNER, useReposStore } from '../../store/repos'
import { findLocalByPath, registerGitHubRepo, registerLocalRepo, revealRepo } from './localRepos'
import { githubErrorMessage } from './useTree'
import { githubRepoOfRemote, parseGitHubRepo, resolveInputPath, verifyRepoFolder } from './verifyRepoFolder'

export interface AddRepoDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 대화상자를 닫은 뒤(취소) 끝난 확인 요청이 저장소를 등록하지 않게 한다 */
function useAlive() {
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  return alive
}

function Shell({ open, onOpenChange, title, description, children }: AddRepoDialogProps & { title: string; description: string; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {open && children}
      </DialogContent>
    </Dialog>
  )
}

/** 대상 호스트 안내 — 폴더는 사이드바에서 보는 호스트에 만들거나 그 호스트에서 찾는다 */
function HostLine() {
  const host = useHost()
  return (
    <p className="text-xs text-muted-foreground">
      대상 호스트: <strong>{host.label}</strong>
    </p>
  )
}

/** 경로 입력 + (이 PC 일 때만) 폴더 선택 창 */
function PathField({ id, value, onChange, placeholder }: { id: string; value: string; onChange(v: string): void; placeholder: string }) {
  const host = useHost()
  const { tauri } = useDeps()
  return (
    <div className="flex gap-2">
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} className="font-mono" />
      {/* 폴더 선택 창은 이 PC 의 창에서만 뜬다 — 원격 호스트의 폴더나 원격 화면에서는 경로를 직접 적는다 */}
      {host.alias === null && tauri.runtime !== 'remote' && (
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void tauri
              .pickFolder()
              .then((p) => p !== null && onChange(p))
              .catch(() => undefined)
          }
        >
          <FolderOpenIcon /> 찾아보기
        </Button>
      )}
    </div>
  )
}

/** 결과 안내: live region 은 미리 렌더해 둔다 */
function ErrorLine({ text }: { text: string | null }) {
  return (
    <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
      {text ?? ''}
    </p>
  )
}

/** 새 프로젝트 — 폴더를 만들어 git 저장소로 초기화하고 로컬 저장소로 연다(GitHub 저장소는 만들지 않는다) */
export function NewProjectDialog(props: AddRepoDialogProps) {
  return (
    <Shell
      {...props}
      title="새 프로젝트"
      description="폴더를 만들어 git 저장소로 시작합니다(빈 첫 커밋 포함). GitHub 저장소는 만들지 않으며, 나중에 저장소 메뉴의 [GitHub 에 올리기] 로 올릴 수 있습니다."
    >
      <NewProjectBody onDone={() => props.onOpenChange(false)} />
    </Shell>
  )
}

function NewProjectBody({ onDone }: { onDone(): void }) {
  const uid = useId()
  const host = useHost()
  const { tauri, home, platform } = useDeps()
  const [name, setName] = useState('')
  const [parent, setParent] = useState(() => useReposStore.getState().lastParent[host.id] ?? '~')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function create() {
    const folder = name.trim()
    if (folder === '' || folder === '.' || folder === '..' || /[\\/:*?"<>|{}]/.test(folder)) {
      setError('폴더 이름에 쓸 수 없는 글자가 있습니다( \\ / : * ? " < > | { } )')
      return
    }
    const base = resolveInputPath(parent, { home, platform })
    if ('error' in base) {
      setError(`상위 폴더: ${base.error}`)
      return
    }
    const path = `${base.path.replace(/[\\/]+$/, '')}${platform === 'win32' ? '\\' : '/'}${folder}`
    if (await tauri.pathExists(path)) {
      setError(`이미 있는 폴더입니다: ${path} — 기존 폴더는 [폴더 열기] 로 여세요`)
      return
    }
    let init = await tauri.gitRun(['init', '-b', 'main', path])
    if (init.code !== 0 && /unknown (switch|option)/i.test(init.stderr)) {
      // git 2.28 미만은 -b 를 모른다
      init = await tauri.gitRun(['init', path])
      if (init.code === 0) init = await tauri.gitRun(['-C', path, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    }
    if (init.code !== 0) {
      setError(`git init 실패: ${init.stderr.trim() || path}`)
      return
    }
    // 작업 폴더(worktree)는 커밋에서 갈라져 나오므로 첫 커밋이 필요하다
    const commit = await tauri.gitRun(['-C', path, 'commit', '--allow-empty', '-m', 'Initial commit'])
    if (commit.code !== 0) {
      setError(
        `폴더는 만들었지만 첫 커밋에 실패했습니다: ${commit.stderr.trim()}\ngit 의 user.name·user.email 을 설정한 뒤 [폴더 열기] 로 ${path} 를 여세요.`,
      )
      return
    }
    const res = await verifyRepoFolder(tauri, { home, platform }, path)
    if (!res.ok) {
      setError(res.error)
      return
    }
    useReposStore.getState().setLastParent(host.id, parent.trim())
    registerLocalRepo(host.id, res.top)
    onDone()
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    void create()
      .catch((err) => setError(messageOf(err)))
      .finally(() => setBusy(false))
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <HostLine />
      <div className="grid gap-1">
        <Label htmlFor={`${uid}-name`}>프로젝트 이름(폴더 이름)</Label>
        <Input id={`${uid}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder="my-project" spellCheck={false} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${uid}-parent`}>만들 위치(상위 폴더)</Label>
        <PathField id={`${uid}-parent`} value={parent} onChange={setParent} placeholder={platform === 'win32' ? 'C:\\src' : '~/src'} />
      </div>
      <ErrorLine text={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          취소
        </Button>
        <Button type="submit" disabled={busy || name.trim() === '' || parent.trim() === ''}>
          만들기
        </Button>
      </DialogFooter>
    </form>
  )
}

/** 이어서 물어볼 것 — 커밋이 없는 저장소, GitHub 에서 확인할 수 없는 저장소 */
type FollowUp = { kind: 'commit' } | { kind: 'github'; repo: string; reason: string }

/** 폴더 열기 — origin 이 GitHub 저장소면 그 저장소로(폴더는 기준 저장소), 아니면 로컬 저장소로 연다 */
export function OpenFolderDialog(props: AddRepoDialogProps) {
  return (
    <Shell
      {...props}
      title="폴더 열기"
      description="이미 있는 git 저장소 폴더를 엽니다. GitHub 저장소면 그 저장소의 이슈와 함께, 아니면 앱 안의 작업으로 관리합니다. 작업 폴더(worktree)는 이 저장소에서 만들며, 폴더의 체크아웃은 건드리지 않습니다."
    >
      <OpenFolderBody onDone={() => props.onOpenChange(false)} />
    </Shell>
  )
}

function OpenFolderBody({ onDone }: { onDone(): void }) {
  const uid = useId()
  const host = useHost()
  const { tauri, github, home, platform } = useDeps()
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [follow, setFollow] = useState<FollowUp | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useAlive()

  async function openFolder(opts: { commit?: boolean; asLocal?: boolean }) {
    const res = await verifyRepoFolder(tauri, { home, platform }, path)
    if (!alive.current) return
    if (!res.ok) {
      setError(res.error)
      return
    }
    const already = findLocalByPath(host.id, res.top, platform)
    if (already !== undefined) {
      revealRepo(LOCAL_OWNER, already)
      onDone()
      return
    }
    const gh = res.origin === null ? null : githubRepoOfRemote(res.origin)
    if (gh && !opts.asLocal) {
      try {
        // GitHub 표기(대소문자)로 맞추고, 볼 수 있는 저장소인지 확인한다
        const repo = await github.getRepo(gh.owner, gh.name)
        if (!alive.current) return
        registerGitHubRepo(repo.owner, repo.name, { hostId: host.id, path: res.top })
        onDone()
      } catch (e) {
        const reason = e instanceof GitHubError && e.code === 'not_found' ? '찾을 수 없거나 볼 권한이 없습니다' : githubErrorMessage(e)
        setFollow({ kind: 'github', repo: `${gh.owner}/${gh.name}`, reason })
      }
      return
    }
    if (!res.hasCommits) {
      if (!opts.commit) {
        setFollow({ kind: 'commit' })
        return
      }
      const commit = await tauri.gitRun(['-C', res.top, 'commit', '--allow-empty', '-m', 'Initial commit'])
      if (commit.code !== 0) {
        setError(`첫 커밋에 실패했습니다: ${commit.stderr.trim()}`)
        return
      }
    }
    registerLocalRepo(host.id, res.top)
    onDone()
  }

  function run(opts: { commit?: boolean; asLocal?: boolean }) {
    setBusy(true)
    setError(null)
    setFollow(null)
    void openFolder(opts)
      .catch((err) => setError(messageOf(err)))
      .finally(() => setBusy(false))
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        run({})
      }}
      className="grid gap-3"
    >
      <HostLine />
      <div className="grid gap-1">
        <Label htmlFor={`${uid}-path`}>저장소 폴더</Label>
        <PathField
          id={`${uid}-path`}
          value={path}
          onChange={(v) => {
            setPath(v)
            setError(null)
            setFollow(null)
          }}
          placeholder={platform === 'win32' ? 'C:\\src\\my-repo' : '~/src/my-repo'}
        />
      </div>
      <ErrorLine text={error} />
      {follow?.kind === 'commit' && (
        <div role="status" className="grid gap-2 rounded border p-2 text-sm">
          <span>커밋이 하나도 없는 저장소입니다. 작업 폴더를 만들려면 첫 커밋이 필요합니다.</span>
          <Button type="button" size="sm" variant="outline" className="justify-self-start" disabled={busy} onClick={() => run({ commit: true, asLocal: true })}>
            빈 첫 커밋 만들고 열기
          </Button>
        </div>
      )}
      {follow?.kind === 'github' && (
        <div role="status" className="grid gap-2 rounded border p-2 text-sm">
          <span>
            origin 이 GitHub 저장소 <strong>{follow.repo}</strong> 이지만 확인하지 못했습니다 — {follow.reason}
          </span>
          <Button type="button" size="sm" variant="outline" className="justify-self-start" disabled={busy} onClick={() => run({ asLocal: true })}>
            이슈 없이 로컬 저장소로 열기
          </Button>
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          취소
        </Button>
        <Button type="submit" disabled={busy || path.trim() === ''}>
          열기
        </Button>
      </DialogFooter>
    </form>
  )
}

/** GitHub 저장소 추가 — 내 계정·내 조직 소유가 아니어서 목록에 없는 저장소(협업 중인 저장소·공개 저장소) */
export function AddGitHubRepoDialog(props: AddRepoDialogProps) {
  return (
    <Shell
      {...props}
      title="GitHub 저장소 추가"
      description="목록에 없는 GitHub 저장소(다른 사람·조직 소유)를 트리에 더합니다. 이슈 목록은 볼 권한이, push·PR 은 쓰기 권한이 있어야 합니다."
    >
      <AddGitHubBody onDone={() => props.onOpenChange(false)} />
    </Shell>
  )
}

function AddGitHubBody({ onDone }: { onDone(): void }) {
  const uid = useId()
  const { github } = useDeps()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useAlive()

  async function add() {
    const parsed = parseGitHubRepo(text)
    if (!parsed) {
      setError('owner/name 또는 https://github.com/owner/name 형식으로 입력하세요')
      return
    }
    try {
      const repo = await github.getRepo(parsed.owner, parsed.name)
      if (!alive.current) return
      registerGitHubRepo(repo.owner, repo.name)
      onDone()
    } catch (e) {
      setError(e instanceof GitHubError && e.code === 'not_found' ? `저장소를 찾을 수 없거나 볼 권한이 없습니다: ${parsed.owner}/${parsed.name}` : githubErrorMessage(e))
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        void add().finally(() => setBusy(false))
      }}
      className="grid gap-3"
    >
      <div className="grid gap-1">
        <Label htmlFor={`${uid}-repo`}>저장소</Label>
        <Input id={`${uid}-repo`} value={text} onChange={(e) => setText(e.target.value)} placeholder="owner/name" spellCheck={false} className="font-mono" />
      </div>
      <ErrorLine text={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          취소
        </Button>
        <Button type="submit" disabled={busy || text.trim() === ''}>
          추가
        </Button>
      </DialogFooter>
    </form>
  )
}
