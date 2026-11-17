// 저장소 주소·폴더 이름 풀이(폴더 열기·기준 저장소 지정 공용). 폴더 확인(verifyRepoFolder)은 원격 CLI 와 함께 쓰도록 core 에 있다.
export { resolveInputPath, verifyRepoFolder } from '@minmo/core'
export type { RepoFolder, VerifyResult } from '@minmo/core'

/** git remote 주소에서 "owner/repo" 를 뽑는다(https·ssh 형식, 호스트는 가리지 않는다). 알 수 없으면 null */
export function repoOfRemote(url: string): string | null {
  const m = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/**
 * github.com 의 저장소 주소일 때만 owner·name 을 돌려준다 — GitLab 등 다른 곳의 주소를 GitHub 저장소로 잘못 보지 않게.
 * (~/.ssh/config 의 별칭을 호스트로 쓴 주소는 알 수 없어 null)
 */
export function githubRepoOfRemote(url: string): { owner: string; name: string } | null {
  const m = /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return m ? { owner: m[1], name: m[2] } : null
}

/** 경로의 마지막 폴더 이름 */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}

/** "owner/name" 또는 GitHub 주소 → 저장소 */
export function parseGitHubRepo(input: string): { owner: string; name: string } | null {
  const text = input.trim()
  const fromUrl = githubRepoOfRemote(text)
  if (fromUrl) return fromUrl
  const m = /^([A-Za-z0-9][A-Za-z0-9_-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(text)
  return m ? { owner: m[1], name: m[2] } : null
}
