// [Red 스텁 #120] 기본 작업 공간 — 저장소 없는 가짜 IssueTarget(호스트마다 1개). 판정 함수의 동작은 Phase 5.2 에서 구현한다
import { worktreeId } from '@minmo/core'
import type { IssueTarget } from '@minmo/core'

import type { WorkTab } from '../store/ui'

/** `_` 로 시작하는 소유자는 GitHub 에 없다(LOCAL_OWNER='_local' 선례) */
export const DEFAULT_TARGET: IssueTarget = { owner: '_default', repo: 'default', key: 'default', number: null, title: '' }

export const DEFAULT_CORE_ID = worktreeId(DEFAULT_TARGET.owner, DEFAULT_TARGET.repo, DEFAULT_TARGET.key)

export function isDefaultTarget(_t: Pick<IssueTarget, 'owner'>): boolean {
  return false
}

export function isDefaultIssueId(_id: string): boolean {
  return false
}

/** 기본 또는 ★기타 — 터미널 탭을 쓰는 이슈 */
export function hasTerminalTabs(_id: string): boolean {
  return false
}

/** 기본은 저장된 작업 탭과 관계없이 늘 '터미널' 이다 */
export function workTabOf(_id: string, tab: WorkTab): WorkTab {
  return tab
}
