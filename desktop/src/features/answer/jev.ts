// TypeSafe Jev 판정(#122) — 요청 만들기·응답 해석·오류 문구. 스텁: Phase 5.2(U7)에서 구현한다(Plan §10).

/** Jev 로 보내는 터미널 글자의 상한(UTF-8 바이트) */
export const JEV_MAX_BYTES = 30_000
/** Jev 로 보내는 터미널 글자의 줄 수 상한 */
export const JEV_MAX_LINES = 200

export type JevChoice = { choice: string; probability: number }
/** 칩 3개 — 모르는 답 형식이면 그 항목은 null("판정 없음") */
export type JevVerdict = { need: JevChoice | null; outcome: JevChoice | null; urgency: { level: number; probability: number } | null }

/** 끝에서 max 바이트(UTF-8) 이내 — 글자 중간이면 다음 글자부터 */
export function tailBytes(_text: string, _max: number): string {
  return ''
}

/** POST /v1/systemone 요청 본문(JSON) */
export function buildJevRequest(_text: string): string {
  return ''
}

export function parseJevResponse(_json: string): JevVerdict | null {
  return null
}

/** 오류 코드(jev_key_missing·jev_keychain·jev_http_{status}·jev_network 등) → 문구 */
export function jevErrorText(_code: string): string {
  return ''
}
