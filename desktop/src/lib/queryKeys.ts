import type { SettingsScope } from '@minmo/api-client'

// TanStack Query 키. 서버 읽기 캐시는 401 시 queryClient.clear() 로 함께 지워진다.
export const queryKeys = {
  settings: (scope: SettingsScope) =>
    scope.kind === 'global'
      ? (['settings', 'global'] as const)
      : scope.kind === 'org'
        ? (['settings', 'org', scope.owner] as const)
        : (['settings', 'project', scope.owner, scope.repo] as const),
  effectiveAll: ['effective'] as const,
  effective: (owner: string, repo: string) => ['effective', owner, repo] as const,
  notes: (owner: string, repo: string, key: string) => ['notes', owner, repo, key] as const,
  githubOwners: ['github', 'owners'] as const,
  githubRepos: (owner: string) => ['github', 'repos', owner] as const,
  githubIssues: (owner: string, repo: string) => ['github', 'issues', owner, repo] as const,
  githubSource: ['github', 'source'] as const,
}
