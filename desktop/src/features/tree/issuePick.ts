import { createContext } from 'react'

// Why: [새 세션] 대화상자(#122)는 이슈를 누르면 대화상자를 닫고 [에이전트 실행]을 요청한다.
// 줄마다 호스트가 다를 수 있어 여는 동작(open)은 줄이 넘긴다. null 이면 기본 트리 동작이다.
export type IssuePick = (issueId: string, open: () => void) => void

export const IssuePickContext = createContext<IssuePick | null>(null)
