// 작업 호스트 — "이 PC" 또는 SSH 프로필로 접속한 원격. 화면 영역(사이드바·이슈 패널)마다 호스트를 정해
// 그 아래의 useDeps() 가 해당 호스트의 git·파일·터미널 구현과 home·platform 을 돌려주게 한다.
// GitHub·서버 API·키체인 등 호스트와 무관한 것은 항상 이 PC 에서 실행한다.
import { createContext, useCallback, useContext, useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'

import { worktreeId } from '@minmo/core'

import { createSshOps, sshErrorOf } from '../lib/sshHost'
import type { SshError, SshProbe, TauriApi } from '../lib/tauri'
import { SSH_HOST_PREFIX, hostIdOf, useHostsStore } from '../store/hosts'
import { DepsContext, useBaseDeps } from './deps'
import type { AppDeps } from './deps'

const SEP = '|'

export interface Host {
  /** 'local' 또는 'ssh:<별칭>' */
  id: string
  alias: string | null
  label: string
  /** 원격에 tmux 가 있는가(이 PC 는 false) */
  tmux: boolean
  /** core 의 worktree id 를 이 호스트의 id 로 — 이 PC 는 그대로라 기존 저장 값과 호환된다 */
  scope(coreId: string): string
  issueId(owner: string, repo: string, key: string): string
  /** 이 호스트의 id 인가 */
  owns(id: string): boolean
}

const hostCache = new Map<string, Host>()

export function hostOf(alias: string | null, tmux = false): Host {
  const key = `${alias ?? ''}\n${tmux}`
  const hit = hostCache.get(key)
  if (hit) return hit
  const prefix = alias === null ? '' : `${SSH_HOST_PREFIX}${alias}${SEP}`
  const host: Host = {
    id: hostIdOf(alias),
    alias,
    label: alias ?? '이 PC',
    tmux,
    scope: (coreId) => prefix + coreId,
    issueId: (owner, repo, key2) => prefix + worktreeId(owner, repo, key2),
    owns: (id) => (alias === null ? !id.startsWith(SSH_HOST_PREFIX) : id.startsWith(prefix)),
  }
  hostCache.set(key, host)
  return host
}

/** 이슈 id 가 속한 원격 호스트의 별칭(이 PC 면 null) */
export function aliasOfIssue(id: string): string | null {
  if (!id.startsWith(SSH_HOST_PREFIX)) return null
  const end = id.indexOf(SEP)
  return end < 0 ? null : id.slice(SSH_HOST_PREFIX.length, end)
}

/** 호스트 접두사를 뗀 core worktree id */
export function coreIdOf(id: string): string {
  return id.startsWith(SSH_HOST_PREFIX) ? id.slice(id.indexOf(SEP) + 1) : id
}

const depsCache = new WeakMap<AppDeps, Map<string, AppDeps>>()

/** base 에서 호스트에 따라 달라지는 부분(tauri 의 호스트 작업·home·platform)만 바꾼 deps */
function hostDeps(base: AppDeps, alias: string, probe: SshProbe): AppDeps {
  let map = depsCache.get(base)
  if (!map) depsCache.set(base, (map = new Map()))
  const key = `${alias}\n${probe.home}\n${probe.platform}\n${probe.tmux}`
  let deps = map.get(key)
  if (!deps) {
    deps = { ...base, tauri: { ...base.tauri, ...createSshOps(base.tauri, alias, probe, base.gitToken) }, home: probe.home, platform: probe.platform }
    map.set(key, deps)
  }
  return deps
}

const HostContext = createContext<Host>(hostOf(null))

export function useHost(): Host {
  return useContext(HostContext)
}

/** 아래 영역의 호스트를 정한다. 연결을 확인하지 못한 원격이면 이 PC 로 둔다 */
export function HostScope({ alias, children }: { alias: string | null; children: ReactNode }) {
  const base = useBaseDeps()
  const probe = useHostsStore((s) => (alias === null ? undefined : s.probes[alias]))
  const host = alias !== null && probe ? hostOf(alias, probe.tmux) : hostOf(null)
  const deps = alias !== null && probe ? hostDeps(base, alias, probe) : base
  return (
    <HostContext.Provider value={host}>
      <DepsContext.Provider value={deps}>{children}</DepsContext.Provider>
    </HostContext.Provider>
  )
}

/** 호스트의 deps — 영역 밖(다른 호스트의 worktree 서비스 등)에서 쓸 때 */
export function useHostDeps(): (host: Host) => AppDeps {
  const base = useBaseDeps()
  return useCallback(
    (host: Host) => {
      const probe = host.alias === null ? undefined : useHostsStore.getState().probes[host.alias]
      return host.alias !== null && probe ? hostDeps(base, host.alias, probe) : base
    },
    [base],
  )
}

const inflight = new Map<string, { promise?: Promise<void> }>()

/**
 * 원격 호스트에 접속해 확인한다(probe). 같은 호스트를 이미 확인하는 중이면 새로 접속하지 않고 그 확인을 기다린다 —
 * 트리의 여러 저장소가 같은 호스트에 묶여 있어도 한 번만 접속한다
 */
export function probeHost(tauri: Pick<TauriApi, 'sshProbe'>, alias: string, trustNew = false): Promise<void> {
  const st = useHostsStore.getState()
  // 진행 표시(connecting)가 기준이다 — 상태를 처음으로 되돌리면(테스트 등) 남은 확인을 기다리지 않는다
  const running = inflight.get(alias)?.promise
  if (running && st.connecting[alias]) return running
  st.setConnecting(alias, true)
  st.setError(alias, null)
  const entry: { promise?: Promise<void> } = {}
  inflight.set(alias, entry)
  entry.promise = (async () => {
    try {
      const p = await tauri.sshProbe(alias, trustNew)
      useHostsStore.getState().setProbe(alias, p)
    } catch (e) {
      useHostsStore.getState().setError(alias, sshErrorOf(e))
    } finally {
      if (inflight.get(alias) === entry) inflight.delete(alias)
      useHostsStore.getState().setConnecting(alias, false)
    }
  })()
  return entry.promise
}

export interface HostStatus {
  /** 이 PC 이거나 연결을 확인한 원격 */
  ready: boolean
  connecting: boolean
  error: SshError | null
  /** 다시 연결한다. trustNew: 처음 보는 호스트 키를 등록한다 */
  connect(trustNew?: boolean): Promise<void>
}

/**
 * 호스트의 연결 상태. 아직 확인하지 않은 원격(연결 중·오류 아님)이면 한 번 접속한다 —
 * 실패하면 자동으로 다시 하지 않는다(사용자가 [다시 시도])
 */
export function useHostStatus(alias: string | null): HostStatus {
  const { tauri } = useBaseDeps()
  const probed = useHostsStore((s) => alias === null || s.probes[alias] !== undefined)
  const connecting = useHostsStore((s) => alias !== null && !!s.connecting[alias])
  const error = useHostsStore((s) => (alias === null ? null : (s.errors[alias] ?? null)))
  const connect = useCallback(async (trustNew = false) => (alias === null ? undefined : probeHost(tauri, alias, trustNew)), [tauri, alias])

  // 연결 기록이 지워져도(호스트 정보 수정 → clearProbe) 다시 접속한다. 오류가 있으면 사용자가 [다시 시도] 할 때까지 둔다
  useEffect(() => {
    if (alias !== null && !probed && !connecting && !error) void probeHost(tauri, alias)
  }, [alias, tauri, probed, connecting, error])

  return useMemo(() => ({ ready: probed, connecting, error, connect }), [probed, connecting, error, connect])
}

/** 사이드바에서 볼 호스트를 고른다 — 원격은 연결을 확인한 뒤에 전환된다 */
export function useHostConnection() {
  const { tauri } = useBaseDeps()
  const selected = useHostsStore((s) => s.selected)
  // 지난 실행에서 고른 원격은 시작할 때 다시 연결한다(useHostStatus 의 자동 연결)
  const status = useHostStatus(selected)

  const connect = useCallback(
    async (alias: string | null, trustNew = false) => {
      useHostsStore.getState().select(alias)
      if (alias !== null) await probeHost(tauri, alias, trustNew)
    },
    [tauri],
  )

  return useMemo(
    () => ({
      selected,
      /** 고른 호스트를 쓸 수 있는가(이 PC 이거나 연결 확인됨) */
      ready: status.ready,
      connecting: status.connecting,
      error: status.error,
      connect,
    }),
    [selected, status.ready, status.connecting, status.error, connect],
  )
}
