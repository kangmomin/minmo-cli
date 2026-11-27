// Claude Code 마지막 답변(#122) — 세션 기록(jsonl) 끝부분을 해석한다. 스텁: Phase 5.2(U6)에서 구현한다(Plan §9).
import type { ClaudeReplyTail } from '../../lib/tauri'

/** 기록 끝부분에서 마지막 주 대화(하위 에이전트 제외) assistant 답변의 글(없으면 null) */
export function parseLastReply(_tail: string): string | null {
  return null
}

/** 빈 줄·코드 펜스를 뺀 앞 3줄(줄당 160자) */
export function replyPreview(_text: string): string[] {
  return []
}

/** 원격 호스트에서 기록 시각과 끝부분의 assistant 줄을 읽는 스크립트($1 = 작업 폴더 slug) */
export const REMOTE_REPLY_SCRIPT = ''

/** REMOTE_REPLY_SCRIPT 의 출력 → 기록 끝부분(기록이 없으면 null) */
export function parseRemoteReply(_stdout: string): ClaudeReplyTail | null {
  return null
}
