import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'

import { DepsProvider } from '../app/deps'
import type { AppDeps } from '../app/deps'
import { createFakeApi, createFakeGitHub, createFakeTauri } from './fakes'

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  })
}

export function makeDeps(partial: Partial<AppDeps> = {}): AppDeps {
  return {
    api: createFakeApi(),
    tauri: createFakeTauri().tauri,
    github: createFakeGitHub(),
    home: '/home/u',
    platform: 'linux',
    gitToken: async () => null,
    ...partial,
  }
}

export function makeWrapper(deps: AppDeps, queryClient = makeQueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <DepsProvider value={deps}>{children}</DepsProvider>
      </QueryClientProvider>
    )
  }
}

export function renderWithDeps(ui: ReactNode, deps: AppDeps, queryClient = makeQueryClient()) {
  return { ...render(ui, { wrapper: makeWrapper(deps, queryClient) }), queryClient }
}

export function renderHookWithDeps<T>(hook: () => T, deps: AppDeps, queryClient = makeQueryClient()) {
  return { ...renderHook(hook, { wrapper: makeWrapper(deps, queryClient) }), queryClient }
}
