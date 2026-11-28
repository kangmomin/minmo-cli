// Why: 보내기와 API 키는 Rust(commands/jev.rs)가 한다 — 여기서는 요청 만들기·응답 해석·오류 문구만 맡는다(#122)

export const JEV_MAX_BYTES = 30_000
export const JEV_MAX_LINES = 200
/** Why: 요청 본문 상한(UTF-8 바이트) — Rust 는 64KiB 로 한 번 더 본다 */
const MAX_BODY_BYTES = 60 * 1024

export type JevChoice = { choice: string; probability: number }
/** Why: 칩 3개 — 모르는 답 형식이면 그 항목은 null("판정 없음") */
export type JevVerdict = { need: JevChoice | null; outcome: JevChoice | null; urgency: { level: number; probability: number } | null }

const NEED: Record<string, string> = {
  permission: 'The coding agent asks the user to allow a tool run or a file change',
  question: 'The coding agent asks the user a question and waits for the answer',
  next_task: 'The coding agent finished and waits for the next task',
  error: 'The coding agent stopped on an error',
  none: 'The coding agent waits for nothing (still working or unclear)',
}
const OUTCOME: Record<string, string> = {
  success: 'The last task was done as asked',
  partial: 'Only part of the last task was done',
  failed: 'The last task failed',
  unknown: 'Cannot tell from the terminal',
}
const URGENCY = ['low', 'medium', 'high']

const encoder = new TextEncoder()
const byteLength = (s: string) => encoder.encode(s).length
const isContinuationByte = (b: number) => (b & 0xc0) === 0x80

/** Why: 끝에서 max 바이트(UTF-8) 이내 — 글자 중간이면 다음 글자부터 */
export function tailBytes(text: string, max: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= max) return text
  let start = bytes.length - max
  while (start < bytes.length && isContinuationByte(bytes[start])) start++
  return new TextDecoder().decode(bytes.subarray(start))
}

function requestBody(state: string): string {
  return JSON.stringify({
    model: 'jev-latest',
    state,
    questions: {
      need: { type: 'choice', instructions: 'What does the coding agent in this terminal wait for from the user now?', criteria: NEED },
      outcome: { type: 'choice', instructions: 'How did the last task in this terminal end?', criteria: OUTCOME },
      urgency: { type: 'score', criteria: URGENCY },
    },
  })
}

export function buildJevRequest(text: string): string {
  let state = tailBytes(text, JEV_MAX_BYTES)
  let body = requestBody(state)
  // Why: JSON 이스케이프는 역슬래시·따옴표를 2배, 제어 글자를 6배로 늘린다 — 잰 본문이 넘친 만큼 끝부분을 더 줄인다
  for (let over = byteLength(body) - MAX_BODY_BYTES; over > 0 && state !== ''; over = byteLength(body) - MAX_BODY_BYTES) {
    state = tailBytes(state, Math.max(0, byteLength(state) - over))
    body = requestBody(state)
  }
  return body
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
/** Why: 고른 것의 확률 — 없으면 응답의 confidence */
const probabilityOf = (v: Record<string, unknown>, key: string) => (isRecord(v.probabilities) ? finite(v.probabilities[key]) : null) ?? finite(v.confidence)

function parseChoice(v: unknown, known: Record<string, string>): JevChoice | null {
  if (!isRecord(v) || v.type !== 'choice' || typeof v.choice !== 'string' || !Object.hasOwn(known, v.choice)) return null
  const probability = probabilityOf(v, v.choice)
  return probability === null ? null : { choice: v.choice, probability }
}

function parseScore(v: unknown): JevVerdict['urgency'] {
  if (!isRecord(v) || v.type !== 'score') return null
  const score = finite(v.score)
  if (score === null) return null
  // Why: Math.round(-0.4) 는 -0 이다 — Math.max(0, -0) 이 +0 으로 바꾼다
  const level = Math.min(URGENCY.length - 1, Math.max(0, Math.round(score)))
  const probability = probabilityOf(v, String(level))
  return probability === null ? null : { level, probability }
}

export function parseJevResponse(json: string): JevVerdict | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(raw) || !isRecord(raw.answers)) return null
  const a = raw.answers
  return { need: parseChoice(a.need, NEED), outcome: parseChoice(a.outcome, OUTCOME), urgency: parseScore(a.urgency) }
}

/** Why: 거절 값의 오류 코드 — 실제 invoke 는 문자열로, 테스트·mock 은 Error(code) 로 거절한다 */
export function jevCode(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function jevErrorText(code: string): string {
  switch (code) {
    case 'jev_key_missing':
      return 'Jev API 키가 없습니다 — 서버 설정의 "세션 요약"에서 저장하세요'
    case 'jev_key_invalid':
      return 'Jev API 키는 공백 없는 영문·숫자·기호(보이는 ASCII)여야 합니다'
    case 'jev_keychain':
      return 'OS 키체인을 쓰지 못했습니다'
    case 'jev_http_401':
      return 'Jev API 키가 맞지 않습니다 — 서버 설정에서 다시 저장하세요'
    case 'jev_http_429':
    case 'jev_http_529':
      return 'TypeSafe 가 지금 바쁩니다 — 잠시 뒤 다시 누르세요'
    case 'jev_network':
      return 'TypeSafe(api.typesafe.ai)에 연결하지 못했습니다'
    case 'jev_too_large':
      return '보낼 글자가 너무 깁니다'
  }
  const http = /^jev_http_(\d+)$/.exec(code)
  return http ? `Jev 판정을 받지 못했습니다(HTTP ${http[1]})` : 'Jev 판정을 받지 못했습니다'
}
