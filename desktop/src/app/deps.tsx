// 의존성 주입 컨텍스트(배선 전용). 테스트는 fake 를 주입한다.
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

import type { ApiClient, Platform } from '@minmo/api-client'

import type { GitHubClient } from '@minmo/core'
import type { TauriApi } from '../lib/tauri'

export interface AppDeps {
  api: ApiClient
  tauri: TauriApi
  github: GitHubClient
  home: string
  platform: Platform
  /** 원격 git 에 넘길 GitHub 토큰 — 이 PC 의 gh 로그인, 없으면 서버가 준 토큰. 얻지 못하면 null */
  gitToken(): Promise<string | null>
}

/** 영역의 호스트에 맞춘 deps — 원격 호스트 영역(app/host.tsx HostScope)에서는 tauri·home·platform 이 원격 것이다 */
export const DepsContext = createContext<AppDeps | null>(null)
/** 항상 이 PC 의 deps */
const BaseDepsContext = createContext<AppDeps | null>(null)

export function DepsProvider({ value, children }: { value: AppDeps; children: ReactNode }) {
  return (
    <BaseDepsContext.Provider value={value}>
      <DepsContext.Provider value={value}>{children}</DepsContext.Provider>
    </BaseDepsContext.Provider>
  )
}

/** 호스트와 무관하게 이 PC 에서 실행해야 하는 것(PTY 입출력·ssh 실행 등)에 쓴다 */
export function useBaseDeps(): AppDeps {
  const deps = useContext(BaseDepsContext)
  if (!deps) throw new Error('DepsProvider 가 없습니다')
  return deps
}

export function useDeps(): AppDeps {
  const deps = useContext(DepsContext)
  if (!deps) throw new Error('DepsProvider 가 없습니다')
  return deps
}
