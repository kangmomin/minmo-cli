// TUI 트리 모델(순수) — 소유자 › 저장소 › 이슈를 펼침 상태에 따라 한 줄 목록으로 편다.
import { isOwnerVisible, isRepoVisible, worktreeId } from '@minmo/core'
import type { GitHubOwner, GitHubRepo, RepoSelection, WorktreeEntry } from '@minmo/core'

export type IssueItem = { key: string; number: number | null; title: string; state: 'open' | 'closed' }

export type Row =
  | { kind: 'owner'; id: string; depth: 0; owner: GitHubOwner; expanded: boolean }
  | { kind: 'repo'; id: string; depth: 1; repo: GitHubRepo; expanded: boolean; hidden: boolean; worktrees: number }
  | { kind: 'issue'; id: string; depth: 2; repo: GitHubRepo; issue: IssueItem; worktree: WorktreeEntry | undefined }
  | { kind: 'note'; id: string; depth: 1 | 2; text: string }

export type TreeData = {
  owners: GitHubOwner[]
  repos: Record<string, GitHubRepo[] | 'loading' | { error: string }>
  issues: Record<string, IssueItem[] | 'loading' | { error: string }>
}

export type View = {
  sel: RepoSelection
  /** true 면 숨긴 저장소도 보여 준다(f 로 표시 여부를 바꿀 때) */
  showAll: boolean
  expanded: ReadonlySet<string>
  search: string
  worktrees: Record<string, WorktreeEntry>
}

const repoKey = (r: GitHubRepo) => `${r.owner}/${r.name}`

function countWorktrees(worktrees: Record<string, WorktreeEntry>, r: GitHubRepo): number {
  const prefix = worktreeId(r.owner, r.name, '')
  return Object.keys(worktrees).filter((id) => id.startsWith(prefix)).length
}

export function buildRows(data: TreeData, v: View): Row[] {
  const rows: Row[] = []
  const q = v.search.toLowerCase()
  const match = (s: string) => q === '' || s.toLowerCase().includes(q)
  for (const o of data.owners) {
    const ownerHasWorktree = Object.keys(v.worktrees).some((id) => id.toLowerCase().startsWith(`${o.login.toLowerCase()}/`))
    if (!v.showAll && !isOwnerVisible(v.sel, o.login) && !ownerHasWorktree) continue
    const oid = `o:${o.login}`
    const oExpanded = v.expanded.has(oid) || q !== ''
    rows.push({ kind: 'owner', id: oid, depth: 0, owner: o, expanded: oExpanded })
    if (!oExpanded) continue
    const repos = data.repos[o.login]
    if (repos === undefined || repos === 'loading') {
      rows.push({ kind: 'note', id: `${oid}:loading`, depth: 1, text: '불러오는 중…' })
      continue
    }
    if (!Array.isArray(repos)) {
      rows.push({ kind: 'note', id: `${oid}:error`, depth: 1, text: repos.error })
      continue
    }
    for (const r of repos) {
      const visible = isRepoVisible(v.sel, r.owner, r.name)
      const worktrees = countWorktrees(v.worktrees, r)
      if (!v.showAll && !visible && worktrees === 0) continue
      if (!match(r.name)) continue
      const rid = `r:${repoKey(r)}`
      const rExpanded = v.expanded.has(rid)
      rows.push({ kind: 'repo', id: rid, depth: 1, repo: r, expanded: rExpanded, hidden: !visible, worktrees })
      if (!rExpanded) continue
      const issues = data.issues[repoKey(r)]
      if (issues === undefined || issues === 'loading') {
        rows.push({ kind: 'note', id: `${rid}:loading`, depth: 2, text: '불러오는 중…' })
        continue
      }
      if (!Array.isArray(issues)) {
        rows.push({ kind: 'note', id: `${rid}:error`, depth: 2, text: issues.error })
        continue
      }
      for (const i of issues) {
        const worktree = v.worktrees[worktreeId(r.owner, r.name, i.key)]
        // 데스크탑 트리와 같은 규칙: closed 는 이 기기에 worktree 가 있을 때만
        if (i.state === 'closed' && !worktree) continue
        rows.push({ kind: 'issue', id: `i:${repoKey(r)}#${i.key}`, depth: 2, repo: r, issue: i, worktree })
      }
    }
  }
  return rows
}
