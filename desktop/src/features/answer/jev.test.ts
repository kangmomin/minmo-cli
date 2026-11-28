// TypeSafe Jev 판정(#122) — 보낼 글자 자르기·요청 크기·응답 해석·오류 문구(Plan §10, U7)
import { describe, expect, it } from 'vitest'

import { JEV_MAX_BYTES, buildJevRequest, jevErrorText, parseJevResponse, tailBytes } from './jev'

const bytes = (s: string) => new TextEncoder().encode(s).length

type Question = { type: string; criteria: Record<string, unknown> | unknown[] }

describe('tailBytes', () => {
  it('EC-12 끝에서 UTF-8 바이트 상한 안으로 자르고, 글자 중간에서 자르지 않는다(한글·상자 글자·이모지)', () => {
    expect(tailBytes('abcdef', 3)).toBe('def')
    expect(tailBytes('abc', 10)).toBe('abc')
    // 가·나·다 는 3바이트 — 7바이트면 "가" 의 끝 1바이트는 버리고 다음 글자부터
    expect(tailBytes('가나다', 7)).toBe('나다')
    expect(tailBytes('──┼──', 7)).toBe('──')
    // 이모지는 4바이트(서로게이트 쌍)
    expect(tailBytes('a😀b', 5)).toBe('😀b')
    expect(tailBytes('a😀b', 4)).toBe('b')
  })
})

describe('buildJevRequest', () => {
  it('AC-10 요청: 모델 jev-latest, 터미널 글자(state), 필요한 것·결과(choice)·급함(score) 질문', () => {
    const raw = buildJevRequest('$ claude\n권한을 허용할까요? (y/n)')
    expect(raw).toMatch(/^\{/)
    const body = JSON.parse(raw) as { model: string; state: string; questions: Record<string, Question> }
    expect(body.model).toBe('jev-latest')
    expect(body.state).toBe('$ claude\n권한을 허용할까요? (y/n)')
    expect(body.questions.need.type).toBe('choice')
    expect(Object.keys(body.questions.need.criteria).sort()).toEqual(['error', 'next_task', 'none', 'permission', 'question'])
    expect(body.questions.outcome.type).toBe('choice')
    expect(Object.keys(body.questions.outcome.criteria).sort()).toEqual(['failed', 'partial', 'success', 'unknown'])
    expect(body.questions.urgency.type).toBe('score')
    expect(body.questions.urgency.criteria).toHaveLength(3)
  })

  it.each([
    ['한글', '한글 출력 줄입니다'],
    ['상자 글자', '│ ─ ┼ ╭ ╮ ╰ ╯ │'],
    ['역슬래시·따옴표', '\\"\\"\\"\\"'],
  ])('EC-12 최악 크기(%s)여도 보내는 글자는 30,000바이트, 본문은 60KiB 이내이고 끝부분을 보낸다', (_kind, unit) => {
    const lines = Array.from({ length: 2000 }, (_, i) => `${i} ${unit.repeat(20)}`)
    const text = lines.join('\n')
    const raw = buildJevRequest(text)
    expect(raw).toMatch(/^\{/)
    expect(bytes(raw)).toBeLessThanOrEqual(60 * 1024)
    const body = JSON.parse(raw) as { state: string }
    expect(bytes(body.state)).toBeLessThanOrEqual(JEV_MAX_BYTES)
    expect(body.state.length).toBeGreaterThan(0)
    expect(text.endsWith(body.state)).toBe(true)
  })
})

describe('parseJevResponse', () => {
  const answer = (o: Record<string, unknown> = {}) =>
    JSON.stringify({
      model: 'jev-latest',
      usage: { input_tokens: 10, output_tokens: 3 },
      answers: {
        need: { type: 'choice', choice: 'permission', confidence: 0.8, probabilities: { permission: 0.9, question: 0.05, next_task: 0.03, error: 0.01, none: 0.01 } },
        outcome: { type: 'choice', choice: 'partial', confidence: 0.6, probabilities: { success: 0.2, partial: 0.7, failed: 0.05, unknown: 0.05 } },
        urgency: { type: 'score', score: 1.6, confidence: 0.7, legend: { 0: 'low', 1: 'medium', 2: 'high' }, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 } },
        ...o,
      },
    })

  it('AC-10 칩 3개: 필요한 것·결과(고른 것 + 그 확률)·급함(점수를 반올림한 단계)', () => {
    expect(parseJevResponse(answer())).toMatchObject({ need: { choice: 'permission', probability: 0.9 }, outcome: { choice: 'partial', probability: 0.7 }, urgency: { level: 2 } })
  })

  it.each([
    [2.7, 2],
    [-0.4, 0],
    [0.49, 0],
    [1.5, 2],
  ])('AC-10 급함 점수 %s 는 0~2 단계 %s 로 본다', (score, level) => {
    const raw = answer({ urgency: { type: 'score', score, confidence: 0.5, legend: { 0: 'low', 1: 'medium', 2: 'high' }, probabilities: { 0: 0.3, 1: 0.4, 2: 0.3 } } })
    expect(parseJevResponse(raw)?.urgency?.level).toBe(level)
  })

  it('EC-11 모르는 답 형식(다른 type·모르는 선택지)은 그 항목만 판정 없음(null), 깨진 응답은 null', () => {
    const v = parseJevResponse(answer({ need: { type: 'ranking', order: ['x'] }, outcome: { type: 'choice', choice: 'exploded', confidence: 1, probabilities: { exploded: 1 } } }))
    expect(v).toMatchObject({ need: null, outcome: null, urgency: { level: 2 } })
    expect(parseJevResponse('not json')).toBeNull()
    expect(parseJevResponse(JSON.stringify({ model: 'jev-latest' }))).toBeNull()
  })
})

describe('jevErrorText', () => {
  it('EC-11 키 없음·키체인 오류·401·429/529·그 밖·네트워크는 각자 문구가 있다(429·529 는 같은 안내)', () => {
    const codes = ['jev_key_missing', 'jev_keychain', 'jev_http_401', 'jev_http_429', 'jev_http_529', 'jev_http_500', 'jev_network', 'jev_too_large']
    for (const c of codes) expect(jevErrorText(c), c).not.toBe('')
    expect(jevErrorText('jev_key_missing')).toContain('키')
    expect(jevErrorText('jev_http_429')).toBe(jevErrorText('jev_http_529'))
    expect(new Set([jevErrorText('jev_key_missing'), jevErrorText('jev_keychain'), jevErrorText('jev_http_401'), jevErrorText('jev_http_429')]).size).toBe(4)
  })
})
