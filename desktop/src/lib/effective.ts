import type { QueryClient } from '@tanstack/react-query'

import type { ApiClient, Effective } from '@minmo/api-client'

import { isOfflineError } from './apiErrors'
import { queryKeys } from './queryKeys'

/**
 * E12 effective 조회. 서버 미연결이면 세션 내 마지막 읽기 캐시로 계속 진행한다(EC-17).
 * 캐시도 없으면 원래 오류를 던진다 → worktree 서비스가 "서버 연결 필요"로 변환.
 */
export async function fetchEffective(qc: QueryClient, api: ApiClient, owner: string, repo: string): Promise<Effective> {
  const key = queryKeys.effective(owner, repo)
  try {
    return await qc.fetchQuery({ queryKey: key, queryFn: () => api.getEffective(owner, repo), staleTime: 0 })
  } catch (e) {
    const cached = qc.getQueryData<Effective>(key)
    if (cached && isOfflineError(e)) return cached
    throw e
  }
}
