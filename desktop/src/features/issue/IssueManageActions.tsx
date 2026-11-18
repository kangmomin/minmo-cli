// 이슈 머리줄의 [닫힘] 배지 · [수정] · [닫기](#64). ★기타에는 두지 않는다(IssueHeader 가 거른다).
// IssueHeader 가 이슈마다 key 를 바꿔 새로 마운트한다 — 이 이슈에서 닫은 기록이 다른 이슈로 넘어가지 않게
import { CircleCheckIcon, PencilIcon, UserMinusIcon, UserPlusIcon } from 'lucide-react'
import { useId, useRef, useState } from 'react'

import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { cn } from '../../lib/utils'
import { AssigneeBadge } from '../tree/AssigneeBadge'
import { shrinkBadge } from '../tree/badgeClasses'
import { githubErrorMessage } from '../tree/useTree'
import { CloseIssueDialog } from './CloseIssueDialog'
import { EditIssueDialog } from './EditIssueDialog'
import { ASSIGN_OFF_TEXT, ASSIGN_ON_TEXT, useAssignMe, useIssueManageInfo, useIssueMutations } from './useIssueManage'
import type { ManagedTarget } from './useIssueManage'

export function IssueManageActions({ target }: { target: ManagedTarget }) {
  const info = useIssueManageInfo(target)
  const { closeTask } = useIssueMutations(target)
  const [editOpen, setEditOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  // 목록 캐시가 없으면(조회 실패·아직 안 받음) 닫은 결과를 캐시에 넣을 수 없다 — 이 화면에서 닫은 것은 직접 기억한다
  const [closedHere, setClosedHere] = useState(false)
  const state = closedHere ? 'closed' : info.state
  const editRef = useRef<HTMLButtonElement>(null)
  const blockedId = useId()
  const noun = info.kind === 'task' ? '작업' : '이슈'
  // 올리기는 작업 제목·상태가 그대로인지 확인하므로(publishRepo) 그동안 수정·닫기를 막는다
  const blocked = info.publishing ? { disabled: true, 'aria-describedby': blockedId } : {}
  const assign = useAssignMe(target.owner, target.repo, target.number)
  const assignedToMe = assign.me !== null && info.assignees.includes(assign.me)
  const [assigning, setAssigning] = useState(false)
  const [assignError, setAssignError] = useState<string | null>(null)
  async function toggleAssign() {
    setAssigning(true)
    setAssignError(null)
    try {
      await assign.set(!assignedToMe)
    } catch (e) {
      setAssignError(githubErrorMessage(e))
    } finally {
      setAssigning(false)
    }
  }
  return (
    <>
      <AssigneeBadge assignees={info.assignees} me={assign.me} full className={cn('max-w-64', shrinkBadge)} />
      {state === 'closed' && (
        <Badge variant="secondary" data-testid="issue-closed-badge">
          닫힘
        </Badge>
      )}
      <Button ref={editRef} size="sm" variant="ghost" {...blocked} onClick={() => setEditOpen(true)}>
        <PencilIcon /> {noun} 수정
      </Button>
      {state === 'open' && (
        <Button
          size="sm"
          variant="ghost"
          {...blocked}
          onClick={() => {
            if (info.kind === 'github') return setCloseOpen(true)
            // 로컬 작업은 트리 메뉴의 "작업 닫기" 처럼 바로 닫는다. 이 버튼이 사라지므로 포커스를 [수정] 으로 옮긴다
            closeTask()
            editRef.current?.focus()
          }}
        >
          <CircleCheckIcon /> {noun} 닫기
        </Button>
      )}
      {/* 트리 행의 우클릭 메뉴와 같은 동작 — 우클릭 메뉴는 키보드로 열 수 없다(AX-01) */}
      {info.kind === 'github' && (
        <Button size="sm" variant="ghost" disabled={assign.me === null || assigning} onClick={() => void toggleAssign()}>
          {assignedToMe ? <UserMinusIcon /> : <UserPlusIcon />} {assignedToMe ? ASSIGN_OFF_TEXT : ASSIGN_ON_TEXT}
        </Button>
      )}
      {assignError && (
        <span role="alert" className="text-xs text-destructive">
          {assignError}
        </span>
      )}
      {info.publishing && (
        <span id={blockedId} className="text-xs text-muted-foreground">
          GitHub 에 올리는 중에는 바꿀 수 없음
        </span>
      )}
      <EditIssueDialog target={target} info={info} open={editOpen} onOpenChange={setEditOpen} />
      {info.kind === 'github' && (
        <CloseIssueDialog
          target={target}
          open={closeOpen}
          onOpenChange={setCloseOpen}
          onClosed={() => setClosedHere(true)}
          focusAfterClose={() => editRef.current}
        />
      )}
    </>
  )
}
