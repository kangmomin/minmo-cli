import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'

import type { Platform } from '@minmo/api-client'
import { DEFAULT_WORKSPACE_ROOT, checkBaseDir } from '@minmo/core'

import { useBaseDeps } from '../../app/deps'
import { hostOf } from '../../app/host'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { sshErrorOf, sshErrorText } from '../../lib/sshHost'
import type { SshHostInfo, SshHostInput, SshProbe } from '../../lib/tauri'
import { baseDirOf, useHostsStore } from '../../store/hosts'

/** 원격 호스트 관리 — ~/.ssh/config 의 Host 를 고르거나 앱에 직접 등록한다 */
export function HostsSettings() {
  // Why: 본문은 불러오는 중·오류 때 먼저 반환한다 — 설명은 어느 상태에서나 보이게 바깥에 둔다
  return (
    <>
      <p className="text-sm text-muted-foreground">
        ssh 로 접속해 그 호스트에서 worktree 를 만들고 터미널·파일을 씁니다. ~/.ssh/config 의 Host 를 고르거나 아래에서 직접 등록하세요. 원격에는 git 이 있어야 합니다.
      </p>
      <HostsBody />
    </>
  )
}

type Check = { state: 'checking' } | { state: 'ok'; probe: SshProbe } | { state: 'error'; text: string; hostKey: boolean }

const probeText = (p: SshProbe) => `${p.platform === 'darwin' ? 'macOS' : 'Linux'} · ${p.git.replace(/^git version /, 'git ')} · ${p.tmux ? 'tmux 있음' : 'tmux 없음'}`
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const EMPTY: SshHostInput = { alias: '', hostName: '', user: '', port: 22, identityFile: null }

/** 원격 호스트 설정 본문 — ~/.ssh/config 의 Host 와 직접 등록한 호스트 */
function HostsBody() {
  const { tauri, platform } = useBaseDeps()
  const aliases = useHostsStore((s) => s.aliases)
  const add = useHostsStore((s) => s.add)
  const remove = useHostsStore((s) => s.remove)
  const useTmux = useHostsStore((s) => s.useTmux)
  const setUseTmux = useHostsStore((s) => s.setUseTmux)
  const uid = useId()
  const [hosts, setHosts] = useState<SshHostInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [checks, setChecks] = useState<Record<string, Check>>({})
  /** 등록·수정 폼(null 이면 닫힘). editing 은 수정 중인 별칭 */
  const [form, setForm] = useState<{ value: SshHostInput; editing: string | null } | null>(null)

  useEffect(() => {
    let alive = true
    tauri
      .sshHosts()
      .then((h) => alive && setHosts(h))
      .catch((e: unknown) => alive && setLoadError(errorText(e)))
    return () => {
      alive = false
    }
  }, [tauri])

  async function check(alias: string, trustNew = false) {
    setChecks((c) => ({ ...c, [alias]: { state: 'checking' } }))
    try {
      const probe = await tauri.sshProbe(alias, trustNew)
      useHostsStore.getState().setProbe(alias, probe)
      // 트리·이슈 화면에 남은 이 호스트의 지난 오류도 지운다(같은 연결 상태를 쓴다)
      useHostsStore.getState().setError(alias, null)
      setChecks((c) => ({ ...c, [alias]: { state: 'ok', probe } }))
    } catch (e) {
      const err = sshErrorOf(e)
      useHostsStore.getState().setError(alias, err)
      setChecks((c) => ({ ...c, [alias]: { state: 'error', text: sshErrorText(alias, err), hostKey: err.kind === 'host_key' } }))
    }
  }

  async function deleteHost(alias: string) {
    try {
      setHosts(await tauri.sshHostRemove(alias))
      remove(alias)
    } catch (e) {
      setLoadError(errorText(e))
    }
  }

  if (loadError) {
    return (
      <p role="alert" className="rounded bg-destructive/10 p-2 text-sm text-destructive">
        호스트 목록을 처리하지 못했습니다: {loadError}
      </p>
    )
  }
  if (!hosts) return <p className="text-sm text-muted-foreground">불러오는 중…</p>
  // 설정 파일에서 지워진 호스트도 뺄 수 있게 목록에 남긴다
  const missing = aliases.filter((a) => !hosts.some((h) => h.alias === a))
  const rows = [...hosts.map((h) => ({ ...h, gone: false })), ...missing.map((alias) => ({ alias, hostName: null, user: null, source: 'config' as const, port: null, identityFile: null, gone: true }))]

  return (
    <div className="grid gap-3">
      {rows.length === 0 && <p className="text-sm text-muted-foreground">~/.ssh/config 에 Host 항목이 없습니다. 아래에서 호스트를 직접 등록하세요.</p>}
      <ul className="grid gap-2" aria-label="ssh 호스트">
        {rows.map((h) => {
          const added = aliases.includes(h.alias)
          const c = checks[h.alias]
          const target = [h.user, h.hostName].filter(Boolean).join('@') + (h.port && h.port !== 22 ? `:${h.port}` : '')
          return (
            <li key={h.alias} className="grid gap-1 rounded border p-2" data-testid={`ssh-host-${h.alias}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {h.alias}
                  {target && <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{target}</span>}
                  {h.source === 'app' && <span className="ml-2 text-xs font-normal text-muted-foreground">앱에 등록</span>}
                </span>
                {!h.gone && (
                  <Button size="sm" variant="ghost" disabled={c?.state === 'checking'} onClick={() => void check(h.alias)}>
                    연결 확인
                  </Button>
                )}
                {h.source === 'app' && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setForm({ editing: h.alias, value: { alias: h.alias, hostName: h.hostName ?? '', user: h.user ?? '', port: h.port ?? 22, identityFile: h.identityFile } })
                      }
                    >
                      수정
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`${h.alias} 등록 삭제`} onClick={() => void deleteHost(h.alias)}>
                      삭제
                    </Button>
                  </>
                )}
                <Button size="sm" variant={added ? 'outline' : 'secondary'} aria-pressed={added} onClick={() => (added ? remove(h.alias) : add(h.alias))}>
                  {added ? '빼기' : '추가'}
                </Button>
              </div>
              {h.gone && <p className="text-xs text-muted-foreground">~/.ssh/config 에 더 이상 없는 호스트입니다.</p>}
              {/* live region 은 결과가 오기 전에 있어야 변화가 읽힌다 */}
              <p role="status" className={c?.state === 'error' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                {c?.state === 'checking' && '확인하는 중…'}
                {c?.state === 'ok' && `연결됨 — ${probeText(c.probe)}`}
                {c?.state === 'error' && c.text}
              </p>
              {c?.state === 'error' && c.hostKey && (
                <div>
                  <Button size="sm" variant="outline" onClick={() => void check(h.alias, true)}>
                    호스트 키 등록하고 연결
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {form ? (
        <HostForm
          key={form.editing ?? 'new'}
          initial={form.value}
          editing={form.editing !== null}
          onCancel={() => setForm(null)}
          onSave={async (value) => {
            setHosts(await tauri.sshHostSave(value))
            // 주소가 바뀌었을 수 있다 — 예전 호스트에서 확인한 값(홈·tmux)을 쓰지 않게 다시 확인하게 한다
            useHostsStore.getState().clearProbe(value.alias)
            // 새로 등록한 호스트는 바로 쓸 수 있게 작업 호스트 목록에 넣는다
            if (form.editing === null) add(value.alias)
            setForm(null)
          }}
        />
      ) : (
        <div>
          <Button size="sm" variant="outline" onClick={() => setForm({ value: EMPTY, editing: null })}>
            호스트 직접 등록
          </Button>
        </div>
      )}

      <div className="grid gap-2 border-t pt-3">
        <span id={`${uid}-base`} className="text-sm font-medium">
          기본 폴더
        </span>
        <p className="text-xs text-muted-foreground">
          호스트마다 worktree 와 메인 clone 을 둘 폴더입니다. 경로 설정이 <code>{DEFAULT_WORKSPACE_ROOT}</code> 로 시작할 때 그 부분을 대신합니다(비우면 그대로). 이미 만든 worktree 는 옮기지 않습니다.
        </p>
        <ul className="grid gap-2" aria-labelledby={`${uid}-base`}>
          <BaseDirRow alias={null} platform={platform} />
          {aliases.map((a) => (
            // 원격은 Linux·macOS 만 지원한다
            <BaseDirRow key={a} alias={a} platform="linux" />
          ))}
        </ul>
      </div>

      <div className="grid gap-1 border-t pt-3">
        <label htmlFor={`${uid}-tmux`} className="flex items-center gap-2 text-sm">
          <input id={`${uid}-tmux`} type="checkbox" checked={useTmux} onChange={(e) => setUseTmux(e.target.checked)} aria-describedby={`${uid}-tmux-hint`} />
          원격 터미널에 tmux 사용
        </label>
        <p id={`${uid}-tmux-hint`} className="text-xs text-muted-foreground">
          끄면(기본) 일반 로그인 셸로 엽니다. 켜면 tmux 가 있는 호스트에서 앱을 끄거나 연결이 끊겨도 터미널이 유지됩니다. 새로 여는(또는 다시 시작한) 터미널부터 적용됩니다.
        </p>
      </div>
    </div>
  )
}

/** 한 호스트의 기본 폴더 — 이 PC 에 저장한다(서버는 호스트를 모른다) */
function BaseDirRow({ alias, platform }: { alias: string | null; platform: Platform }) {
  const uid = useId()
  const host = hostOf(alias)
  const saved = useHostsStore((s) => baseDirOf(s, host.id))
  const setBaseDir = useHostsStore((s) => s.setBaseDir)
  const [value, setValue] = useState(saved ?? '')
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null)
  // 저장된 값이 바뀌면(다른 화면이 바꾼 경우 포함) 입력란을 맞춘다 — 옛 글자가 남아 있으면 [저장] 한 번으로 그 변경을 되돌리게 된다
  const [seen, setSeen] = useState(saved)
  if (seen !== saved) {
    setSeen(saved)
    setValue(saved ?? '')
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    const v = value.trim()
    if (v === '') {
      setBaseDir(host.id, null)
      setNote({ error: false, text: '해제했습니다 — 경로 설정 그대로 씁니다' })
      return
    }
    const error = checkBaseDir(v, platform)
    if (error) {
      setNote({ error: true, text: error })
      return
    }
    setBaseDir(host.id, v)
    setValue(v)
    setNote({ error: false, text: '저장했습니다 — 다음에 여는 이슈부터 씁니다' })
  }

  return (
    <li data-testid={`base-dir-${host.id}`}>
      <form onSubmit={submit} className="grid gap-1">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${uid}-dir`} className="w-28 shrink-0 truncate">
            {host.label}
          </Label>
          <Input
            id={`${uid}-dir`}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setNote(null)
            }}
            placeholder={DEFAULT_WORKSPACE_ROOT}
            spellCheck={false}
            className="font-mono"
            aria-invalid={note?.error ? true : undefined}
            aria-describedby={`${uid}-note`}
          />
          <Button type="submit" size="sm" variant="outline" disabled={value.trim() === (saved ?? '')}>
            저장
          </Button>
        </div>
        {/* live region 은 결과가 오기 전에 있어야 변화가 읽힌다 */}
        <p id={`${uid}-note`} role={note?.error ? 'alert' : 'status'} className={note?.error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
          {note?.text ?? ''}
        </p>
      </form>
    </li>
  )
}

function HostForm({ initial, editing, onSave, onCancel }: { initial: SshHostInput; editing: boolean; onSave(v: SshHostInput): Promise<void>; onCancel(): void }) {
  const uid = useId()
  const [alias, setAlias] = useState(initial.alias)
  const [hostName, setHostName] = useState(initial.hostName)
  const [user, setUser] = useState(initial.user)
  const [port, setPort] = useState(String(initial.port))
  const [identityFile, setIdentityFile] = useState(initial.identityFile ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const p = Number(port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      setError('포트는 1~65535 사이의 숫자여야 합니다')
      return
    }
    setError(null)
    setSaving(true)
    try {
      await onSave({ alias: alias.trim(), hostName: hostName.trim(), user: user.trim(), port: p, identityFile: identityFile.trim() || null })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const field = (name: string) => `${uid}-${name}`
  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-2 rounded border p-3" aria-label={editing ? '호스트 수정' : '호스트 직접 등록'}>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <Label htmlFor={field('alias')}>이름</Label>
          <Input id={field('alias')} value={alias} onChange={(e) => setAlias(e.target.value)} disabled={editing} placeholder="office-dev" spellCheck={false} required />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={field('host')}>호스트 주소</Label>
          <Input id={field('host')} value={hostName} onChange={(e) => setHostName(e.target.value)} placeholder="10.0.0.5 또는 dev.example.com" spellCheck={false} required />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={field('user')}>사용자</Label>
          <Input id={field('user')} value={user} onChange={(e) => setUser(e.target.value)} placeholder="ubuntu" spellCheck={false} required />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={field('port')}>포트</Label>
          <Input id={field('port')} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} required />
        </div>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={field('key')}>키 파일 (선택)</Label>
        <Input
          id={field('key')}
          value={identityFile}
          onChange={(e) => setIdentityFile(e.target.value)}
          placeholder="~/.ssh/id_ed25519"
          spellCheck={false}
          aria-describedby={field('key-hint')}
        />
        <p id={field('key-hint')} className="text-xs text-muted-foreground">
          이 PC 의 개인키 경로입니다. 비워 두면 ssh-agent 와 기본 키를 씁니다. 비밀번호 접속은 지원하지 않습니다.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          취소
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {editing ? '저장' : '등록'}
        </Button>
      </div>
    </form>
  )
}
