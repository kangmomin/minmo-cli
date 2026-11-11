import { useId, useState } from 'react'
import type { FormEvent } from 'react'

import { expandHome } from '@minmo/api-client'

import { useDeps } from '../../app/deps'
import { useHost } from '../../app/host'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { baseRepoOf, useHostsStore } from '../../store/hosts'

export interface BaseRepoDialogProps {
  owner: string
  repo: string
  open: boolean
  onOpenChange(open: boolean): void
}

/** git remote 주소에서 "owner/repo" 를 뽑는다(https·ssh 형식). 알 수 없으면 null */
export function repoOfRemote(url: string): string | null {
  const m = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/** 그 OS 의 절대 경로인가 */
function isAbsolute(path: string, windows: boolean): boolean {
  return windows ? /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') : path.startsWith('/')
}

type Check = { state: 'ok'; note: string } | { state: 'warn'; note: string } | { state: 'error'; note: string }

/** 기준 저장소 — 이 호스트에 이미 있는 저장소 폴더를 가져와, 이슈 worktree 를 그 저장소에서 만든다 */
export function BaseRepoDialog({ owner, repo, open, onOpenChange }: BaseRepoDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            기준 저장소 폴더 — {owner}/{repo}
          </DialogTitle>
          <DialogDescription>
            이 호스트에 이미 clone 해 둔 저장소 폴더를 지정하면, 새로 clone 하지 않고 그 저장소에서 이슈별 worktree 를 만듭니다. 그 폴더의 체크아웃은 건드리지 않습니다.
            비워 두면 설정의 메인 clone 경로를 씁니다.
          </DialogDescription>
        </DialogHeader>
        {open && <BaseRepoBody owner={owner} repo={repo} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function BaseRepoBody({ owner, repo, onDone }: { owner: string; repo: string; onDone(): void }) {
  const uid = useId()
  const host = useHost()
  const { tauri, home, platform } = useDeps()
  const current = useHostsStore((s) => baseRepoOf(s, host.id, owner, repo))
  const setBaseRepo = useHostsStore((s) => s.setBaseRepo)
  const [path, setPath] = useState(current ?? '')
  const [check, setCheck] = useState<Check | null>(null)
  const [busy, setBusy] = useState(false)

  /** 입력을 검사하고, 쓸 수 있으면 실제 경로를 돌려준다 */
  async function verify(): Promise<string | null> {
    const raw = path.trim()
    const full = expandHome(raw, home, platform).replace(/[\\/]+$/, '')
    if (raw === '' || !isAbsolute(full, platform === 'win32')) {
      setCheck({ state: 'error', note: '절대 경로(또는 ~ 로 시작하는 경로)를 입력하세요' })
      return null
    }
    // 경로는 설정의 경로 템플릿 자리에 들어가므로 템플릿 기호는 쓸 수 없다
    if (/[{}]/.test(full)) {
      setCheck({ state: 'error', note: '경로에 { } 를 쓸 수 없습니다' })
      return null
    }
    const git = await tauri.gitRun(['-C', full, 'rev-parse', '--git-dir'])
    if (git.code !== 0) {
      setCheck({ state: 'error', note: `git 저장소가 아닙니다: ${git.stderr.trim() || full}` })
      return null
    }
    const origin = await tauri.gitRun(['-C', full, 'remote', 'get-url', 'origin'])
    const found = origin.code === 0 ? repoOfRemote(origin.stdout) : null
    if (found === null) setCheck({ state: 'warn', note: 'origin 원격을 확인할 수 없습니다 — fetch·push 가 되지 않을 수 있습니다' })
    else if (found.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) setCheck({ state: 'warn', note: `origin 이 다른 저장소입니다: ${found}` })
    else setCheck({ state: 'ok', note: `확인됨 — origin: ${found}` })
    return full
  }

  async function guarded(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } catch (e) {
      setCheck({ state: 'error', note: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void guarded(async () => {
      const full = await verify()
      if (full === null) return
      setBaseRepo(host.id, owner, repo, full)
      onDone()
    })
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        대상 호스트: <strong>{host.label}</strong>
      </p>
      <div className="grid gap-1">
        <Label htmlFor={`${uid}-path`}>저장소 폴더</Label>
        <div className="flex gap-2">
          <Input
            id={`${uid}-path`}
            value={path}
            onChange={(e) => {
              setPath(e.target.value)
              setCheck(null)
            }}
            placeholder={platform === 'win32' ? 'C:\\src\\my-repo' : '~/src/my-repo'}
            spellCheck={false}
            className="font-mono"
          />
          <Button type="button" variant="outline" disabled={busy || path.trim() === ''} onClick={() => void guarded(async () => void (await verify()))}>
            확인
          </Button>
        </div>
      </div>
      {/* 결과 안내: live region 은 미리 렌더해 둔다 */}
      <p
        role={check?.state === 'error' ? 'alert' : 'status'}
        className={check?.state === 'error' ? 'text-sm text-destructive' : check?.state === 'warn' ? 'text-sm text-amber-700 dark:text-amber-400' : 'text-sm text-muted-foreground'}
      >
        {check?.note ?? ''}
      </p>
      <DialogFooter>
        {current && (
          <Button
            type="button"
            variant="ghost"
            className="mr-auto"
            onClick={() => {
              setBaseRepo(host.id, owner, repo, null)
              onDone()
            }}
          >
            해제
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onDone}>
          취소
        </Button>
        <Button type="submit" disabled={busy || path.trim() === ''}>
          저장
        </Button>
      </DialogFooter>
    </form>
  )
}
