// 작업 호스트 — "이 PC" 또는 SSH 프로필로 접속한 원격. 화면 영역(사이드바·이슈 패널)마다 호스트를 정해
// 그 아래의 useDeps() 가 해당 호스트의 git·파일·터미널 구현과 home·platform 을 돌려주게 한다.
// GitHub·서버 API·키체인 등 호스트와 무관한 것은 항상 이 PC 에서 실행한다.
import { createContext, useCallback, useContext, useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'

import { worktreeId } from '@minmo/core'

import { createSshOps, sshErrorOf } from '../lib/sshHost'
import type { SshProbe } from '../lib/tauri'
import { useHostsStore } from '../store/hosts'
import { DepsContext, useBaseDeps } from './deps'
import type { AppDeps } from './deps'

export const LOCAL_HOST_ID = 'local'
const SSH_PREFIX = 'ssh:'
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
  const prefix = alias === null ? '' : `${SSH_PREFIX}${alias}${SEP}`
  const host: Host = {
    id: alias === null ? LOCAL_HOST_ID : `${SSH_PREFIX}${alias}`,
    alias,
    label: alias ?? '이 PC',
    tmux,
    scope: (coreId) => prefix + coreId,
    issueId: (owner, repo, key2) => prefix + worktreeId(owner, repo, key2),
    owns: (id) => (alias === null ? !id.startsWith(SSH_PREFIX) : id.startsWith(prefix)),
  }
  hostCache.set(key, host)
  return host
}

/** 이슈 id 가 속한 원격 호스트의 별칭(이 PC 면 null) */
export function aliasOfIssue(id: string): string | null {
  if (!id.startsWith(SSH_PREFIX)) return null
  const end = id.indexOf(SEP)
  return end < 0 ? null : id.slice(SSH_PREFIX.length, end)
}

const depsCache = new WeakMap<AppDeps, Map<string, AppDeps>>()

/** base 에서 호스트에 따라 달라지는 부분(tauri 의 호스트 작업·home·platform)만 바꾼 deps */
function hostDeps(base: AppDeps, alias: string, probe: SshProbe): AppDeps {
  let map = depsCache.get(base)
  if (!map) depsCache.set(base, (map = new Map()))
  const key = `${alias}\n${probe.home}\n${probe.platform}\n${probe.tmux}`
  let deps = map.get(key)
  if (!deps) {
    deps = { ...base, tauri: { ...base.tauri, ...createSshOps(base.tauri, alias, probe) }, home: probe.home, platform: probe.platform }
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

/** 사이드바에서 볼 호스트를 고른다 — 원격은 연결을 확인한 뒤에 전환된다 */
export function useHostConnection() {
  const { tauri } = useBaseDeps()
  const selected = useHostsStore((s) => s.selected)
  const probe = useHostsStore((s) => (s.selected === null ? undefined : s.probes[s.selected]))
  const connecting = useHostsStore((s) => s.connecting)
  const error = useHostsStore((s) => s.error)

  const connect = useCallback(
    async (alias: string | null) => {
      const st = useHostsStore.getState()
      st.select(alias)
      st.setError(null)
      if (alias === null) return
      st.setConnecting(alias)
      try {
        const p = await tauri.sshProbe(alias)
        useHostsStore.getState().setProbe(alias, p)
      } catch (e) {
        // 그 사이 다른 호스트를 골랐으면 이전 시도의 오류는 보여 주지 않는다
        if (useHostsStore.getState().selected === alias) useHostsStore.getState().setError({ alias, error: sshErrorOf(e) })
      } finally {
        if (useHostsStore.getState().connecting === alias) useHostsStore.getState().setConnecting(null)
      }
    },
    [tauri],
  )

  // 지난 실행에서 고른 원격은 시작할 때 다시 연결한다
  useEffect(() => {
    const st = useHostsStore.getState()
    if (st.selected !== null && !st.probes[st.selected] && st.connecting === null && st.error === null) void connect(st.selected)
  }, [connect])

  return useMemo(
    () => ({
      selected,
      /** 고른 호스트를 쓸 수 있는가(이 PC 이거나 연결 확인됨) */
      ready: selected === null || probe !== undefined,
      connecting: connecting !== null && connecting === selected,
      error: error && error.alias === selected ? error.error : null,
      connect,
    }),
    [selected, probe, connecting, error, connect],
  )
}
