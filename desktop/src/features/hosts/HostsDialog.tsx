import { useEffect, useState } from 'react'

import { useBaseDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { sshErrorOf, sshErrorText } from '../../lib/sshHost'
import type { SshHostInfo, SshProbe } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'

export interface HostsDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
}

/** 원격 호스트 관리 — ~/.ssh/config 의 Host 항목 중 minmo 에서 쓸 것을 고른다 */
export function HostsDialog({ open, onOpenChange }: HostsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>원격 호스트</DialogTitle>
          <DialogDescription>
            이 PC 의 ~/.ssh/config 에 있는 Host 로 접속해, 그 호스트에서 worktree 를 만들고 터미널을 엽니다. 원격에는 git 이 있어야 하고, 비공개 저장소는 원격의 git
            자격 증명(예: gh auth setup-git)이 필요합니다. tmux 가 있으면 터미널이 연결이 끊겨도 유지됩니다.
          </DialogDescription>
        </DialogHeader>
        {open && <HostsBody />}
      </DialogContent>
    </Dialog>
  )
}

type Check = { state: 'checking' } | { state: 'ok'; probe: SshProbe } | { state: 'error'; text: string }

const probeText = (p: SshProbe) => `${p.platform === 'darwin' ? 'macOS' : 'Linux'} · ${p.git.replace(/^git version /, 'git ')} · ${p.tmux ? 'tmux 있음' : 'tmux 없음(일반 셸)'}`

function HostsBody() {
  const { tauri } = useBaseDeps()
  const aliases = useHostsStore((s) => s.aliases)
  const add = useHostsStore((s) => s.add)
  const remove = useHostsStore((s) => s.remove)
  const [hosts, setHosts] = useState<SshHostInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [checks, setChecks] = useState<Record<string, Check>>({})

  useEffect(() => {
    let alive = true
    tauri
      .sshHosts()
      .then((h) => alive && setHosts(h))
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [tauri])

  async function check(alias: string) {
    setChecks((c) => ({ ...c, [alias]: { state: 'checking' } }))
    try {
      const probe = await tauri.sshProbe(alias)
      useHostsStore.getState().setProbe(alias, probe)
      setChecks((c) => ({ ...c, [alias]: { state: 'ok', probe } }))
    } catch (e) {
      setChecks((c) => ({ ...c, [alias]: { state: 'error', text: sshErrorText(alias, sshErrorOf(e)) } }))
    }
  }

  if (loadError) {
    return (
      <p role="alert" className="rounded bg-destructive/10 p-2 text-sm text-destructive">
        ssh 설정을 읽지 못했습니다: {loadError}
      </p>
    )
  }
  if (!hosts) return <p className="text-sm text-muted-foreground">불러오는 중…</p>
  // 설정 파일에서 지워진 호스트도 뺄 수 있게 목록에 남긴다
  const missing = aliases.filter((a) => !hosts.some((h) => h.alias === a))
  if (hosts.length === 0 && missing.length === 0) {
    return <p className="text-sm text-muted-foreground">~/.ssh/config 에 Host 항목이 없습니다. Host 를 추가한 뒤 다시 여세요.</p>
  }

  return (
    <ul className="grid gap-2" aria-label="ssh 호스트">
      {[...hosts, ...missing.map((alias) => ({ alias, hostName: null, user: null, gone: true }))].map((h) => {
        const added = aliases.includes(h.alias)
        const c = checks[h.alias]
        const gone = 'gone' in h
        const target = [h.user, h.hostName].filter(Boolean).join('@')
        return (
          <li key={h.alias} className="grid gap-1 rounded border p-2" data-testid={`ssh-host-${h.alias}`}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {h.alias}
                {target && <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{target}</span>}
              </span>
              {!gone && (
                <Button size="sm" variant="ghost" disabled={c?.state === 'checking'} onClick={() => void check(h.alias)}>
                  연결 확인
                </Button>
              )}
              <Button size="sm" variant={added ? 'outline' : 'secondary'} aria-pressed={added} onClick={() => (added ? remove(h.alias) : add(h.alias))}>
                {added ? '빼기' : '추가'}
              </Button>
            </div>
            {gone && <p className="text-xs text-muted-foreground">~/.ssh/config 에 더 이상 없는 호스트입니다.</p>}
            {/* live region 은 결과가 오기 전에 있어야 변화가 읽힌다 */}
            <p role="status" className={c?.state === 'error' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
              {c?.state === 'checking' && '확인하는 중…'}
              {c?.state === 'ok' && `연결됨 — ${probeText(c.probe)}`}
              {c?.state === 'error' && c.text}
            </p>
          </li>
        )
      })}
    </ul>
  )
}
