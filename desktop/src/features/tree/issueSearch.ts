// 저장소의 이슈 목록 검색 — 이슈가 많은 저장소에서 번호·제목으로 찾는다(불러온 목록 안에서만).

/** 이슈(★기타 제외)가 이보다 많을 때만 검색 칸을 보인다 — 적을 때는 한눈에 보이므로 칸이 자리만 차지한다 */
export const ISSUE_SEARCH_MIN = 10

/**
 * 검색어의 단어(공백으로 나눔)가 모두 제목이나 번호에 있어야 맞는다. 대소문자는 가리지 않는다.
 * 번호는 `42` 와 `#42` 둘 다 받는다 — GitHub 에서 복사한 모양 그대로 찾을 수 있게.
 */
export function matchesIssue(issue: { number: number | null; title: string }, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const title = issue.title.toLowerCase()
  const number = issue.number === null ? null : String(issue.number)
  return words.every((w) => title.includes(w) || (number !== null && number.includes(w.replace(/^#/, '')) && /^#?\d+$/.test(w)))
}
