import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'

import { createAppApi } from '../lib/api'
import { expireSession, handleApiError, shouldRetry } from '../lib/apiErrors'
import { createGitHubClient } from '../lib/github'
import { cachedGithubToken, rememberGithubToken } from '../lib/githubToken'
import { KEYCHAIN_KEYS, getTauri } from '../lib/tauri'
import type { AppDeps } from './deps'

/**
 * QueryClient — 계약 "캐시": staleTime 0, retry 4xx 0회·네트워크 1회.
 * 읽기 쿼리 gcTime Infinity(EC-17 세션 내 마지막 읽기 캐시 유지). 서버 오류는 공통 처리(handleApiError)로 보낸다.
 */
export function createAppQueryClient(): QueryClient {
  const holder: { qc?: QueryClient } = {}
  const qc = new QueryClient({
    queryCache: new QueryCache({ onError: (e) => handleApiError(e, { queryClient: holder.qc }) }),
    mutationCache: new MutationCache({ onError: (e) => handleApiError(e, { queryClient: holder.qc }) }),
    defaultOptions: {
      queries: { staleTime: 0, gcTime: Infinity, retry: shouldRetry, refetchOnWindowFocus: false },
      mutations: { retry: 0 },
    },
  })
  holder.qc = qc
  return qc
}

/** 실제 앱 배선: Tauri(또는 mock) + 서버 API + GitHub 클라이언트 */
export async function createAppDeps(queryClient: QueryClient): Promise<AppDeps> {
  const tauri = getTauri()
  const api = createAppApi()
  const [home, platform] = await Promise.all([tauri.homeDir(), tauri.platform()])

  async function githubToken(): Promise<string> {
    const cached = cachedGithubToken()
    if (cached) return cached
    const stored = await tauri.keychainGet(KEYCHAIN_KEYS.githubToken).catch(() => null)
    if (stored) {
      rememberGithubToken(stored)
      return stored
    }
    const { accessToken } = await api.getGithubToken()
    rememberGithubToken(accessToken)
    await tauri.keychainSet(KEYCHAIN_KEYS.githubToken, accessToken).catch(() => undefined)
    return accessToken
  }

  const github = createGitHubClient({
    tauri,
    fetch: (input, init) => globalThis.fetch(input, init),
    getToken: githubToken,
    // EC-02: 서버가 준 GitHub 토큰도 거부 → 세션 폐기 후 로그인 화면
    onUnauthorized: () => {
      rememberGithubToken(null)
      expireSession(queryClient)
    },
  })

  return { api, tauri, github, home, platform }
}
