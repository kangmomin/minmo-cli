// Why: 탭 줄(TerminalTabsBar)과 패널(TerminalTab)이 같은 DOM id 를 쓴다 — 컴포넌트 파일과 분리(react-refresh 규칙).
// 이슈 id 는 길고 id 에 맞지 않는 글자(`/`·`#`·`|`)가 있어 이슈마다 짧은 번호를 붙인다
const issueNos = new Map<string, number>()

function issueNo(issueId: string): number {
  let n = issueNos.get(issueId)
  if (n === undefined) {
    n = issueNos.size + 1
    issueNos.set(issueId, n)
  }
  return n
}

export function tabDomIds(issueId: string, tabId: string): { tab: string; panel: string } {
  const n = issueNo(issueId)
  return { tab: `term-${n}-${tabId}-tab`, panel: `term-${n}-${tabId}-panel` }
}

export function newTerminalButtonId(issueId: string): string {
  return `term-${issueNo(issueId)}-new`
}
