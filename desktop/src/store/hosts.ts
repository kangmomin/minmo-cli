// 원격 호스트(SSH 프로필) 목록과 지금 보는 호스트. 목록·선택은 이 PC 에만 저장한다(서버는 호스트를 모른다).
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import type { SshError, SshProbe } from '../lib/tauri'
import { isLocalOwner } from './repos'

export interface HostsState {
  /** 추가한 ~/.ssh/config 별칭 */
  aliases: string[]
  /** 사이드바에서 고른 호스트(null = 이 PC) */
  selected: string | null
  /** 이번 실행에서 연결을 확인한 호스트 — 값이 있어야 그 호스트의 작업을 실행한다(persist 하지 않음) */
  probes: Record<string, SshProbe>
  /** 연결을 확인하는 중인 호스트(persist 하지 않음) — 같은 호스트를 동시에 두 번 확인하지 않게 */
  connecting: Record<string, true>
  /** 호스트별 마지막 연결 오류(persist 하지 않음) */
  errors: Record<string, SshError>
  /** 기준 저장소: 호스트 id → "owner/repo"(소문자) → 그 호스트의 기존 저장소 폴더. 이슈 worktree 를 여기서 만든다 */
  baseRepos: Record<string, Record<string, string>>
  /** 기본 폴더: 호스트 id → 그 호스트에서 경로 설정의 ~/minmo-workspaces 를 대신할 폴더(core applyBaseDir) */
  baseDirs: Record<string, string>
  /**
   * 연결 호스트: "owner/repo"(소문자) → 그 저장소를 여는 호스트 id('local' 또는 'ssh:<별칭>').
   * 항목이 없으면 사이드바의 작업 호스트를 따른다
   */
  repoHosts: Record<string, string>
  /** 원격 터미널을 전용 tmux 세션으로 여는가(기본: 일반 로그인 셸). 원격에 tmux 가 있을 때만 쓴다 */
  useTmux: boolean

  add(alias: string): void
  remove(alias: string): void
  select(alias: string | null): void
  setProbe(alias: string, probe: SshProbe): void
  /** 등록 정보를 고친 호스트 — 다시 연결해 확인하게 한다 */
  clearProbe(alias: string): void
  setConnecting(alias: string, on: boolean): void
  /** error 가 null 이면 지운다 */
  setError(alias: string, error: SshError | null): void
  /** path 가 null 이면 해제 */
  setBaseRepo(hostId: string, owner: string, repo: string, path: string | null): void
  /** path 가 null 이면 해제 */
  setBaseDir(hostId: string, path: string | null): void
  /** hostId 가 null 이면 해제(작업 호스트를 따름) */
  setRepoHost(owner: string, repo: string, hostId: string | null): void
  setUseTmux(on: boolean): void
}

export const repoKey = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase()

export const LOCAL_HOST_ID = 'local'
export const SSH_HOST_PREFIX = 'ssh:'

/** 호스트 id — 이 PC 는 'local', 원격은 'ssh:<별칭>' */
export const hostIdOf = (alias: string | null): string => (alias === null ? LOCAL_HOST_ID : SSH_HOST_PREFIX + alias)

/** 호스트 id → 별칭(이 PC 는 null). 형식이 다르면 undefined */
export function aliasOfHostId(id: string): string | null | undefined {
  if (id === LOCAL_HOST_ID) return null
  return id.startsWith(SSH_HOST_PREFIX) && id.length > SSH_HOST_PREFIX.length ? id.slice(SSH_HOST_PREFIX.length) : undefined
}

/** 이 호스트에서 저장소의 기준 저장소 폴더(없으면 undefined — 설정의 메인 clone 경로를 쓴다) */
export const baseRepoOf = (s: Pick<HostsState, 'baseRepos'>, hostId: string, owner: string, repo: string): string | undefined =>
  s.baseRepos[hostId]?.[repoKey(owner, repo)]

/** 이 호스트의 기본 폴더(없으면 undefined — 경로 설정 그대로) */
export const baseDirOf = (s: Pick<HostsState, 'baseDirs'>, hostId: string): string | undefined => s.baseDirs[hostId]

/** 저장소의 연결 호스트 id(없으면 undefined — 작업 호스트를 따른다) */
export const repoHostOf = (s: Pick<HostsState, 'repoHosts'>, owner: string, repo: string): string | undefined =>
  s.repoHosts[repoKey(owner, repo)]

/**
 * 저장소를 여는 호스트의 별칭 — 이 PC 는 null, 연결 호스트를 정하지 않았으면 undefined(작업 호스트를 따른다).
 * 로컬 저장소는 폴더가 있는 호스트에 묶여 있어 연결 호스트를 쓰지 않는다
 */
export function repoAliasOf(s: Pick<HostsState, 'repoHosts'>, owner: string, repo: string): string | null | undefined {
  if (isLocalOwner(owner)) return undefined
  const id = repoHostOf(s, owner, repo)
  return id === undefined ? undefined : aliasOfHostId(id)
}

export const useHostsStore = create<HostsState>()(
  persist(
    (set) => ({
      aliases: [],
      selected: null,
      probes: {},
      connecting: {},
      errors: {},
      baseRepos: {},
      baseDirs: {},
      repoHosts: {},
      useTmux: false,
      setUseTmux: (useTmux) => set({ useTmux }),
      setBaseRepo: (hostId, owner, repo, path) =>
        set((s) => {
          const forHost = { ...s.baseRepos[hostId] }
          if (path === null) delete forHost[repoKey(owner, repo)]
          else forHost[repoKey(owner, repo)] = path
          return { baseRepos: { ...s.baseRepos, [hostId]: forHost } }
        }),
      setBaseDir: (hostId, path) =>
        set((s) => {
          const baseDirs = { ...s.baseDirs }
          if (path === null) delete baseDirs[hostId]
          else baseDirs[hostId] = path
          return { baseDirs }
        }),
      setRepoHost: (owner, repo, hostId) =>
        set((s) => {
          const repoHosts = { ...s.repoHosts }
          if (hostId === null) delete repoHosts[repoKey(owner, repo)]
          else repoHosts[repoKey(owner, repo)] = hostId
          return { repoHosts }
        }),
      add: (alias) => set((s) => (s.aliases.includes(alias) ? s : { aliases: [...s.aliases, alias] })),
      // 연결 호스트(repoHosts)는 그대로 둔다 — 호스트 목록은 기기마다 따로지만 연결 호스트는 원격 접속한 기기와 함께 쓰므로,
      // 한 기기의 목록을 정리했다고 다른 기기의 저장소가 엉뚱한 호스트에서 열리면 안 된다(프로젝트 설정에서 바꾼다)
      remove: (alias) =>
        set((s) => {
          const errors = { ...s.errors }
          delete errors[alias]
          return { aliases: s.aliases.filter((a) => a !== alias), selected: s.selected === alias ? null : s.selected, errors }
        }),
      select: (selected) => set({ selected }),
      // 실행 중에는 처음 확인한 값을 유지한다 — 중간에 바뀌면(tmux 설치 등) 그 호스트의 열린 터미널·worktree 서비스가
      // 다시 만들어진다. 바뀐 값은 앱을 다시 시작하면 반영된다
      setProbe: (alias, probe) => set((s) => (s.probes[alias] ? s : { probes: { ...s.probes, [alias]: probe } })),
      clearProbe: (alias) =>
        set((s) => {
          if (!s.probes[alias]) return s
          const probes = { ...s.probes }
          delete probes[alias]
          return { probes }
        }),
      setConnecting: (alias, on) =>
        set((s) => {
          if (!!s.connecting[alias] === on) return s
          const connecting = { ...s.connecting }
          if (on) connecting[alias] = true
          else delete connecting[alias]
          return { connecting }
        }),
      setError: (alias, error) =>
        set((s) => {
          if (error === null && !s.errors[alias]) return s
          const errors = { ...s.errors }
          if (error === null) delete errors[alias]
          else errors[alias] = error
          return { errors }
        }),
    }),
    {
      name: 'minmo-hosts',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ aliases: s.aliases, selected: s.selected, baseRepos: s.baseRepos, baseDirs: s.baseDirs, repoHosts: s.repoHosts, useTmux: s.useTmux }),
    },
  ),
)
