// Claude Code 마지막 답변(#122) — 세션 기록(jsonl) 끝부분에서 마지막 답변을 찾는다.
// 공개된 규격이 아니라 버전에 따라 달라질 수 있다: 해석하지 못한 줄은 건너뛴다.
import type { ClaudeReplyTail } from '../../lib/tauri'
import { REMOTE_SESSION_LOOKUP } from '../agents/subagents'

/** 미리보기 줄 수·한 줄의 글자 수 */
const PREVIEW_LINES = 3
const PREVIEW_CHARS = 160

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** 기록 끝부분에서 마지막 주 대화(하위 에이전트 제외) assistant 답변의 글(없으면 null) */
export function parseLastReply(tail: string): string | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown
    try {
      entry = JSON.parse(lines[i])
    } catch {
      // 파일 중간에서 잘라 읽은 첫 줄·쓰는 중인 마지막 줄
      continue
    }
    if (!isRecord(entry) || entry.type !== 'assistant' || entry.isSidechain === true || !isRecord(entry.message)) continue
    const content = entry.message.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((b): b is { text: string } => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
    // 도구만 부른 답은 건너뛰고 그 앞의 글을 찾는다
    if (text.trim() !== '') return text
  }
  return null
}

/** 빈 줄·코드 펜스를 뺀 앞 3줄(줄당 160자) */
export function replyPreview(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('```'))
    .slice(0, PREVIEW_LINES)
    .map((l) => {
      const chars = Array.from(l)
      return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS - 1).join('')}…` : l
    })
}

/**
 * 원격 호스트에서 기록 시각과 끝부분의 assistant 줄을 읽는 스크립트($1 = 작업 폴더 slug).
 * 첫 줄 = 기록이 바뀐 시각(초), 나머지 = 기록 끝 256KiB 의 assistant 줄(최근 20개). 기록이 없으면 빈 출력.
 * Why: 잘라 읽은 첫 줄의 깨진 글자 때문에 UTF-8 locale 의 grep 이 binary 로 보지 않게 바이트로 비교한다(LC_ALL=C)
 */
export const REMOTE_REPLY_SCRIPT = `${REMOTE_SESSION_LOOKUP}echo "$(mt "$s")"
tail -c 262144 "$s" | LC_ALL=C grep '"type":"assistant"' | tail -n 20`

/** REMOTE_REPLY_SCRIPT 의 출력 → 기록 끝부분(기록이 없으면 null) */
export function parseRemoteReply(stdout: string): ClaudeReplyTail | null {
  if (stdout.trim() === '') return null
  const cut = stdout.indexOf('\n')
  const head = cut < 0 ? stdout : stdout.slice(0, cut)
  return { tail: cut < 0 ? '' : stdout.slice(cut + 1), updatedMs: (Number(head.trim()) || 0) * 1000 }
}
