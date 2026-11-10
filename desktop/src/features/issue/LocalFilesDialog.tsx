import { FolderOpenIcon, Trash2Icon } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'

import { useDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import type { IssueTarget } from '../../lib/worktree'
import { useIssueActions } from './useWorktree'

export interface LocalFilesDialogProps {
  target: IssueTarget
  /** 현재 이슈의 worktree 경로 — "보관" 의 원본 위치 */
  worktreePath: string
  open: boolean
  onOpenChange(open: boolean): void
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 레포별 로컬 파일(.env 등) 보관 폴더 관리. 보관한 파일은 새 worktree 를 만들 때 자동 복사된다 */
export function LocalFilesDialog({ target, worktreePath, open, onOpenChange }: LocalFilesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            로컬 파일 — {target.owner}/{target.repo}
          </DialogTitle>
          <DialogDescription>
            git 에 올리지 않는 파일(.env 등)을 저장소별로 보관합니다. 새 worktree 를 만들 때 같은 위치로 복사되며, 이미 있는 파일은 덮어쓰지 않습니다.
          </DialogDescription>
        </DialogHeader>
        {open && <LocalFilesBody target={target} worktreePath={worktreePath} />}
      </DialogContent>
    </Dialog>
  )
}

function LocalFilesBody({ target, worktreePath }: { target: IssueTarget; worktreePath: string }) {
  const { tauri } = useDeps()
  const actions = useIssueActions()
  const uid = useId()
  const [dir, setDir] = useState<string | null>(null)
  const [files, setFiles] = useState<string[] | null>(null)
  const [rel, setRel] = useState('.env')
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (d: string) => setFiles(await tauri.listFiles(d)), [tauri])

  useEffect(() => {
    let cancelled = false
    actions
      .localFilesDir(target)
      .then(async (d) => {
        if (cancelled) return
        setDir(d)
        await refresh(d)
      })
      .catch((e: unknown) => !cancelled && setError(errorText(e)))
    return () => {
      cancelled = true
    }
  }, [actions, target, refresh])

  async function run(action: () => Promise<void>, done: string) {
    setError(null)
    try {
      await action()
      setStatus(done)
    } catch (e) {
      setError(errorText(e))
    }
  }

  function onSave(e: FormEvent) {
    e.preventDefault()
    const path = rel.trim()
    if (!dir || path === '') return
    void run(async () => {
      await tauri.copyFileInto(worktreePath, path, dir)
      await refresh(dir)
    }, `${path} 을(를) 보관했습니다`)
  }

  return (
    <div className="grid gap-4">
      {dir && (
        <p className="truncate font-mono text-xs text-muted-foreground" title={dir}>
          {dir}
        </p>
      )}

      <section aria-labelledby={`${uid}-list`} className="grid gap-1.5">
        <h3 id={`${uid}-list`} className="text-sm font-medium">
          보관된 파일
        </h3>
        {files === null ? (
          <p className="text-sm text-muted-foreground">불러오는 중…</p>
        ) : files.length === 0 ? (
          <p className="text-sm text-muted-foreground">보관된 파일이 없습니다</p>
        ) : (
          <ul className="grid gap-1">
            {files.map((f) => (
              <li key={f} className="flex items-center gap-2 rounded bg-muted px-2 py-1">
                <code className="min-w-0 flex-1 truncate text-xs">{f}</code>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`${f} 보관 해제`}
                  onClick={() =>
                    void run(async () => {
                      await tauri.removeFileIn(dir!, f)
                      await refresh(dir!)
                    }, `${f} 을(를) 보관 해제했습니다`)
                  }
                >
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form onSubmit={onSave} className="grid gap-1.5">
        <Label htmlFor={`${uid}-rel`}>현재 worktree 에서 보관할 파일</Label>
        <div className="flex gap-2">
          <Input
            id={`${uid}-rel`}
            value={rel}
            onChange={(e) => setRel(e.target.value)}
            aria-describedby={`${uid}-rel-hint`}
            spellCheck={false}
            className="font-mono"
          />
          <Button type="submit" disabled={!dir || rel.trim() === ''}>
            보관
          </Button>
        </div>
        <p id={`${uid}-rel-hint`} className="text-xs text-muted-foreground">
          worktree 기준 상대 경로 (예: .env, config/local.json) · 같은 이름이 있으면 새 내용으로 바꿉니다
        </p>
      </form>

      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="sm" disabled={!dir} onClick={() => void run(() => tauri.openDir(dir!), '보관 폴더를 열었습니다')}>
          <FolderOpenIcon /> 폴더 열기
        </Button>
      </div>

      {/* 결과 안내: live region 은 미리 렌더해 두어야 변화가 읽힌다 */}
      <p role="status" className="text-xs text-muted-foreground">
        {status}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
