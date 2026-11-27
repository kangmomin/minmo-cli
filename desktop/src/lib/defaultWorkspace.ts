import { worktreeId } from '@minmo/core'
import type { IssueTarget } from '@minmo/core'

import type { WorkTab } from '../store/ui'

/** Why: `_` 로 시작하는 소유자는 GitHub 에 없다(LOCAL_OWNER='_local' 선례) */
export const DEFAULT_TARGET: IssueTarget = { owner: '_default', repo: 'default', key: 'default', number: null, title: '' }

export const DEFAULT_CORE_ID = worktreeId(DEFAULT_TARGET.owner, DEFAULT_TARGET.repo, DEFAULT_TARGET.key)

export function isDefaultTarget(t: Pick<IssueTarget, 'owner'>): boolean {
  return t.owner === DEFAULT_TARGET.owner
}

// Why: 원격 호스트의 이슈 id 는 `ssh:<별칭>|` 접두가 붙는다(app/host.tsx 의 SEP)
export function isDefaultIssueId(id: string): boolean {
  return id === DEFAULT_CORE_ID || id.endsWith(`|${DEFAULT_CORE_ID}`)
}

export function hasTerminalTabs(id: string): boolean {
  return isDefaultIssueId(id) || id.endsWith('#etc')
}

export function workTabOf(id: string, tab: WorkTab): WorkTab {
  return isDefaultIssueId(id) ? 'terminal' : tab
}
