// minmo 에서 에이전트를 실행할 때 터미널에 넣을 명령을 만든다(순수 함수 — 화면은 LaunchAgentDialog.tsx)
import type { IssueTarget } from '@minmo/core'

import { isLocalOwner } from '../../store/repos'

export type LaunchKind = 'claude' | 'codex' | 'gemini' | 'custom'
export const LAUNCH_KINDS: readonly LaunchKind[] = ['claude', 'codex', 'gemini', 'custom']
export const LAUNCH_LABEL: Record<LaunchKind, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', custom: '직접 입력' }

/** 명령 틀의 `{prompt}` 자리에 지시문이 (그 터미널의 셸에 맞게 따옴표로 감싸져) 들어간다 */
export const PROMPT_SLOT = '{prompt}'
export const DEFAULT_AGENT_COMMANDS: Record<LaunchKind, string> = {
  claude: `claude ${PROMPT_SLOT}`,
  codex: `codex ${PROMPT_SLOT}`,
  // -i: 지시문을 넣고도 대화형으로 남는다
  gemini: `gemini -i ${PROMPT_SLOT}`,
  custom: '',
}

/** 명령을 받는 셸 — 이 PC(Windows)의 터미널은 PowerShell, 원격·macOS·Linux 는 POSIX 셸 */
export type ShellKind = 'powershell' | 'posix'

/**
 * 지시문을 한 인자로 넘기도록 감싼다. 두 셸 모두 작은따옴표 안에서는 변수·명령 치환이 일어나지 않는다.
 * 지시문에는 이슈 제목(남이 쓴 글)이 들어가므로, 따옴표로 인자가 쪼개져 옵션이 끼어들지 않게 한다.
 */
export function quoteArg(text: string, shell: ShellKind): string {
  if (shell === 'posix') return `'${text.replace(/'/g, `'\\''`)}'`
  const safe = text
    // Windows PowerShell 5.1 은 프로그램에 인자를 넘길 때 안의 큰따옴표를 그대로 둬 인자가 쪼개진다 → 작은따옴표로 바꾼다
    .replace(/"/g, "'")
    // PowerShell 은 둥근 작은따옴표(‘ ’ ‚ ‛)도 문자열을 닫는 따옴표로 본다 → 같은 글자를 겹쳐 쓴다
    .replace(/['‘’‚‛]/g, (q) => q + q)
    // 공백이 있으면 PowerShell 이 큰따옴표로 감싸 넘기는데, 끝의 \ 가 그 닫는 따옴표를 지운다 → 겹쳐 쓴다
    .replace(/\\+$/, (tail) => (/\s/.test(text) ? tail + tail : tail))
  return `'${safe}'`
}

/** 터미널에 한 줄로 넣으므로 줄바꿈·탭은 공백으로 바꾸고, 그 밖의 제어 문자는 뺀다(Enter·ESC 가 섞이면 다른 명령이 실행된다) */
export function oneLine(text: string): string {
  return (
    text
      .replace(/[\r\n\t]+/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .replace(/ {2,}/g, ' ')
      .trim()
  )
}

/** `{prompt}` 가 따옴표 안에 있거나 따옴표에 붙어 있는가(앞쪽에 닫히지 않은 따옴표가 있으면 안이다) */
function slotInQuotes(tpl: string): boolean {
  const parts = tpl.split(PROMPT_SLOT)
  let before = ''
  for (let i = 0; i < parts.length - 1; i++) {
    before += parts[i]
    const odd = (q: string) => before.split(q).length % 2 === 0
    if (odd('"') || odd("'") || odd('`') || /^["'`]/.test(parts[i + 1])) return true
  }
  return false
}

export type BuiltCommand = { ok: true; command: string } | { ok: false; error: string }

/**
 * 명령 틀 + 지시문 → 터미널에 넣을 한 줄.
 * 지시문이 비면 `{prompt}` 와 바로 앞의 한 글자 옵션(-i·-p 처럼 값을 받는 것)을 함께 뺀다 — "gemini -i" 처럼 값 없는 옵션이 남지 않게.
 * 긴 옵션(--full-auto 등)은 값을 받는지 알 수 없어 그대로 둔다.
 * `{prompt}` 를 따옴표 안에 두면 거절한다 — 감싼 지시문이 그 따옴표와 겹쳐 풀려 버린다(지시문에는 남이 쓴 이슈 제목이 들어간다).
 */
export function buildCommand(template: string, prompt: string, shell: ShellKind): BuiltCommand {
  const tpl = oneLine(template)
  if (tpl === '') return { ok: false, error: '실행할 명령을 입력하세요' }
  const text = oneLine(prompt)
  if (!tpl.includes(PROMPT_SLOT)) {
    return text === '' ? { ok: true, command: tpl } : { ok: false, error: `명령에 ${PROMPT_SLOT} 자리가 없어 지시문을 넘길 수 없습니다 — 명령에 ${PROMPT_SLOT} 를 넣거나 지시문을 비우세요` }
  }
  if (slotInQuotes(tpl)) return { ok: false, error: `${PROMPT_SLOT} 를 따옴표로 감싸지 마세요 — 지시문은 자동으로 감싸져 들어갑니다` }
  const command = text === '' ? tpl.replace(/(?:(?<=^|\s)-[A-Za-z]\s+)?\{prompt\}/g, '').replace(/ {2,}/g, ' ').trim() : tpl.split(PROMPT_SLOT).join(quoteArg(text, shell))
  return command === '' ? { ok: false, error: '실행할 명령을 입력하세요' } : { ok: true, command }
}

/** 지시문에 미리 채울 글 — 이슈 번호·제목(GitHub 이슈면 주소도). 기타(번호 없음)는 비운다 */
export function defaultPrompt(t: IssueTarget): string {
  if (t.number === null) return ''
  const head = `#${t.number} ${t.title}`.trim()
  return isLocalOwner(t.owner) ? head : `${head} (https://github.com/${t.owner}/${t.repo}/issues/${t.number})`
}
