// GitHub 토큰(E4) 메모리 캐시. REST 폴백 경로에서만 쓰며, 영속은 OS 키체인(KEYCHAIN_KEYS.githubToken).
let cached: string | null = null

export function rememberGithubToken(token: string | null): void {
  cached = token
}

export function cachedGithubToken(): string | null {
  return cached
}
