// [새 세션](#122) — 프로젝트·이슈 트리 대화상자. 스텁: Phase 5.2(U5)에서 구현한다(Plan §8).
import type { useHostConnection } from '../../app/host'
import type { SidebarProps } from '../tree/Sidebar'

export interface NewSessionDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  connection?: ReturnType<typeof useHostConnection>
  onOpenSettings: SidebarProps['onOpenSettings']
  /** 대화상자가 닫힌 뒤 포커스를 둘 곳(카드 제목, 없으면 [새 세션] 버튼)으로 옮긴다 */
  onCloseFocus(): void
}

export function NewSessionDialog(_props: NewSessionDialogProps) {
  return null
}
