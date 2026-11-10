// "보일 저장소" 선택 판정 — 데스크탑 트리와 원격 CLI 가 같은 규칙을 쓴다.
// 선택(repos)은 서버(E15/E16)에 소문자 "owner/repo" 또는 "owner/*" 로 저장된다. null = 전체 표시.

export type RepoSelection = string[] | null

const key = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase()
const ownerAll = (owner: string) => `${owner.toLowerCase()}/*`

export function isRepoVisible(sel: RepoSelection, owner: string, repo: string): boolean {
  if (sel === null) return true
  return sel.includes(ownerAll(owner)) || sel.includes(key(owner, repo))
}

/** 소유자 노드를 보일지 — 그 소유자의 저장소가 하나라도 선택돼 있으면 보인다 */
export function isOwnerVisible(sel: RepoSelection, owner: string): boolean {
  if (sel === null) return true
  const prefix = `${owner.toLowerCase()}/`
  return sel.some((e) => e.startsWith(prefix))
}

export function isOwnerAllSelected(sel: RepoSelection, owner: string): boolean {
  return sel === null || sel.includes(ownerAll(owner))
}

function normalize(list: Iterable<string>): string[] {
  return [...new Set(list)].sort()
}

/** 저장소 하나를 켜고 끈다. "전체 표시(null)" 상태에서 끄면 빈 선택에서 시작한다 — 호출자가 기존 목록을 채워 넘긴다 */
export function toggleRepo(sel: string[], owner: string, repo: string, on: boolean): string[] {
  const k = key(owner, repo)
  const next = new Set(sel)
  if (on) next.add(k)
  else next.delete(k)
  return normalize(next)
}

/** 소유자 전체("owner/*")를 켜고 끈다. 켜면 그 소유자의 개별 항목은 지운다(중복) */
export function toggleOwnerAll(sel: string[], owner: string, on: boolean): string[] {
  const prefix = `${owner.toLowerCase()}/`
  const rest = sel.filter((e) => !e.startsWith(prefix))
  return normalize(on ? [...rest, ownerAll(owner)] : rest)
}
