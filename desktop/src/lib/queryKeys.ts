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
  /** 보일 저장소 선택(서버, 데스크탑·CLI 공유) */
  visibleRepos: ['visibleRepos'] as const,
  sessions: ['sessions'] as const,
  /** 서버(api-client) 응답을 캐시하는 키들 — 재연결 시 이것만 다시 불러온다. GitHub·git 은 제외(EC-18 자동 재시도 없음, CR-16) */
  serverAll: [['settings'], ['effective'], ['notes'], ['visibleRepos'], ['sessions']] as const,
  githubAll: ['github'] as const,
  githubOwners: ['github', 'owners'] as const,
  githubRepos: (owner: string) => ['github', 'repos', owner] as const,
  githubIssues: (owner: string, repo: string) => ['github', 'issues', owner, repo] as const,
  githubSource: ['github', 'source'] as const,
  // 로컬 git 조회(서버 캐시 아님)
  gitAll: ['git'] as const,
  gitStatus: (cwd: string) => ['git', 'status', cwd] as const,
  gitUnpushed: (cwd: string) => ['git', 'unpushed', cwd] as const,
}
