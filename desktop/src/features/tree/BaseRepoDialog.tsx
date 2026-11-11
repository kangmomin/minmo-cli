import { useId, useState } from 'react'
import type { FormEvent } from 'react'

import { useDeps } from '../../app/deps'
import { useHost } from '../../app/host'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { baseRepoOf, useHostsStore } from '../../store/hosts'
import { repoOfRemote, verifyRepoFolder } from './verifyRepoFolder'

export { repoOfRemote } from './verifyRepoFolder'

export interface BaseRepoDialogProps {
  owner: string
  repo: string
  open: boolean
  onOpenChange(open: boolean): void
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
    const res = await verifyRepoFolder(tauri, { home, platform }, path)
    if (!res.ok) {
      setCheck({ state: 'error', note: res.error })
      return null
    }
    const found = res.origin === null ? null : repoOfRemote(res.origin)
    if (found === null) setCheck({ state: 'warn', note: 'origin 원격을 확인할 수 없습니다 — fetch·push 가 되지 않을 수 있습니다' })
    else if (found.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) setCheck({ state: 'warn', note: `origin 이 다른 저장소입니다: ${found}` })
    else setCheck({ state: 'ok', note: `확인됨 — origin: ${found}` })
    // git 이 돌려준 경로를 저장한다(나중에 git 이 알려 주는 경로와 같은 모양이라 비교가 어긋나지 않는다)
    return res.top
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
