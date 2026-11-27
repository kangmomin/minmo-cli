// Claude Code 마지막 답변(#122) — 세션 기록 끝부분 해석·미리보기·원격 스크립트(Plan §9, U6)
import { describe, expect, it } from 'vitest'

import { REMOTE_SESSION_LOOKUP, REMOTE_SUBAGENTS_SCRIPT } from '../agents/subagents'
import { REMOTE_REPLY_SCRIPT, parseLastReply, parseRemoteReply, replyPreview } from './claudeReply'

/** Claude Code 세션 기록(jsonl)의 한 줄 */
const assistant = (text: string, o: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] }, ...o })
const toolOnly = () => JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } })
const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })

describe('parseLastReply · replyPreview', () => {
  it('AC-09 기록 끝부분에서 마지막 주 대화의 답변 글을 찾고, 앞 3줄(빈 줄·코드 펜스 제외, 줄당 160자)을 보인다', () => {
    // 기록 끝부분은 파일 중간에서 잘라 읽으므로 첫 줄은 깨져 있을 수 있다
    const tail = ['ype":"assistant","message":{"con', user('고쳐 줘'), assistant('예전 답'), user('계속'), assistant('\n\n```\n```\n로그인을 고쳤습니다.\n\n테스트를 돌렸습니다.\n' + 'x'.repeat(200) + '\n넷째 줄'), ''].join('\n')
    const text = parseLastReply(tail)
    expect(text).toContain('로그인을 고쳤습니다.')
    expect(text).not.toContain('예전 답')
    const lines = replyPreview(text ?? '')
    expect(lines).toHaveLength(3)
    expect(lines.slice(0, 2)).toEqual(['로그인을 고쳤습니다.', '테스트를 돌렸습니다.'])
    expect(lines[2].startsWith('x'.repeat(100))).toBe(true)
    expect(lines[2].length).toBeLessThanOrEqual(160)
  })

  it('EC-10 하위 에이전트(isSidechain)의 답변·도구만 쓴 답·깨진 줄은 건너뛰고, 답이 없으면 null', () => {
    const tail = [assistant('주 대화의 답'), toolOnly(), assistant('하위 에이전트의 답', { isSidechain: true }), '{broken', ''].join('\n')
    expect(parseLastReply(tail)).toBe('주 대화의 답')
    expect(parseLastReply([user('질문'), assistant('하위', { isSidechain: true }), '{x'].join('\n'))).toBeNull()
    expect(parseLastReply('')).toBeNull()
  })
})

describe('원격 기록 읽기(ssh)', () => {
  it('EC-10 원격 스크립트는 하위 에이전트 스크립트와 같은 세션 찾기 앞부분을 쓰고, 기록 끝 256KiB 의 assistant 줄만 읽는다', () => {
    expect(REMOTE_SESSION_LOOKUP).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects')
    expect(REMOTE_SESSION_LOOKUP).toContain('if [ -d "$d/$1" ]')
    expect(REMOTE_SUBAGENTS_SCRIPT.startsWith(REMOTE_SESSION_LOOKUP)).toBe(true)
    expect(REMOTE_REPLY_SCRIPT.startsWith(REMOTE_SESSION_LOOKUP)).toBe(true)
    expect(REMOTE_REPLY_SCRIPT).toContain('tail -c 262144')
    expect(REMOTE_REPLY_SCRIPT).toContain(`grep '"type":"assistant"'`)
  })

  it('EC-10 원격 스크립트의 출력(첫 줄 = 기록 시각(초), 나머지 = 기록 줄) → 기록 끝부분, 기록이 없으면(빈 출력) null', () => {
    const out = `1700000000\n${assistant('원격의 답')}\n`
    const tail = parseRemoteReply(out)
    expect(tail?.updatedMs).toBe(1_700_000_000_000)
    expect(parseLastReply(tail?.tail ?? '')).toBe('원격의 답')
    expect(parseRemoteReply('')).toBeNull()
  })
})
