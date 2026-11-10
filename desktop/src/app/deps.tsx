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
}

const DepsContext = createContext<AppDeps | null>(null)

export function DepsProvider({ value, children }: { value: AppDeps; children: ReactNode }) {
  return <DepsContext.Provider value={value}>{children}</DepsContext.Provider>
}

export function useDeps(): AppDeps {
  const deps = useContext(DepsContext)
  if (!deps) throw new Error('DepsProvider 가 없습니다')
  return deps
}
