// Why: 답변 모드(#122)는 트리를 숨기므로 새 세션을 시작할 이슈를 대화상자의 트리에서 고른다.
import { useCallback } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { useUiStore } from '../../store/ui'
import { IssuePickContext } from '../tree/issuePick'
import type { IssuePick } from '../tree/issuePick'
import { SidebarContent } from '../tree/Sidebar'
import type { SidebarProps } from '../tree/Sidebar'

export interface NewSessionDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  connection?: SidebarProps['connection']
  onOpenSettings: SidebarProps['onOpenSettings']
  /** Why: 대화상자가 닫힌 뒤 포커스를 둘 곳(카드 제목, 없으면 [새 세션] 버튼)으로 옮긴다 */
  onCloseFocus(): void
}

export function NewSessionDialog({ open, onOpenChange, connection, onOpenSettings, onCloseFocus }: NewSessionDialogProps) {
  const pick = useCallback<IssuePick>(
    (issueId, openIssue) => {
      onOpenChange(false)
      // Why: 이슈 머리줄은 보이는 이슈와 요청이 다르면 버린다 — 여는 동작(이슈 선택)과 같은 이벤트에서 요청한다.
      useUiStore.getState().setLaunchRequest(issueId)
      openIssue()
    },
    [onOpenChange],
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(e) => {
          // Why: 열기 전 자리([새 세션] 버튼)는 세션 목록이 바뀌면 없어질 수 있어 부르는 쪽이 정한 곳으로 옮긴다.
          e.preventDefault()
          onCloseFocus()
        }}
      >
        <DialogHeader>
          <DialogTitle>새 세션</DialogTitle>
          <DialogDescription>이슈를 고르면 작업 폴더를 준비하고 에이전트 실행 창을 엽니다</DialogDescription>
        </DialogHeader>
        <IssuePickContext.Provider value={pick}>
          <div className="flex h-[60vh] min-h-0 min-w-0 flex-col">
            <SidebarContent
              connection={connection}
              onOpenSettings={(scope, preview) => {
                onOpenChange(false)
                onOpenSettings(scope, preview)
              }}
            />
          </div>
        </IssuePickContext.Provider>
      </DialogContent>
    </Dialog>
  )
}
