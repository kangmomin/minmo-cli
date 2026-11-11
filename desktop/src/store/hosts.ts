// 원격 호스트(SSH 프로필) 목록과 지금 보는 호스트. 목록·선택은 이 PC 에만 저장한다(서버는 호스트를 모른다).
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import type { SshError, SshProbe } from '../lib/tauri'

export interface HostsState {
  /** 추가한 ~/.ssh/config 별칭 */
  aliases: string[]
  /** 사이드바에서 고른 호스트(null = 이 PC) */
  selected: string | null
  /** 이번 실행에서 연결을 확인한 호스트 — 값이 있어야 그 호스트의 작업을 실행한다(persist 하지 않음) */
  probes: Record<string, SshProbe>
  connecting: string | null
  error: { alias: string; error: SshError } | null

  add(alias: string): void
  remove(alias: string): void
  select(alias: string | null): void
  setProbe(alias: string, probe: SshProbe): void
  setConnecting(alias: string | null): void
  setError(e: HostsState['error']): void
}

export const useHostsStore = create<HostsState>()(
  persist(
    (set) => ({
      aliases: [],
      selected: null,
      probes: {},
      connecting: null,
      error: null,
      add: (alias) => set((s) => (s.aliases.includes(alias) ? s : { aliases: [...s.aliases, alias] })),
      remove: (alias) =>
        set((s) => ({
          aliases: s.aliases.filter((a) => a !== alias),
          selected: s.selected === alias ? null : s.selected,
          error: s.error?.alias === alias ? null : s.error,
        })),
      select: (selected) => set({ selected }),
      // 실행 중에는 처음 확인한 값을 유지한다 — 중간에 바뀌면(tmux 설치 등) 그 호스트의 열린 터미널·worktree 서비스가
      // 다시 만들어진다. 바뀐 값은 앱을 다시 시작하면 반영된다
      setProbe: (alias, probe) => set((s) => (s.probes[alias] ? s : { probes: { ...s.probes, [alias]: probe } })),
      setConnecting: (connecting) => set({ connecting }),
      setError: (error) => set({ error }),
    }),
    {
      name: 'minmo-hosts',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ aliases: s.aliases, selected: s.selected }),
    },
  ),
)
