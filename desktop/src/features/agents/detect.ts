// 터미널에서 도는 프로그램이 어떤 에이전트이고 무엇을 하는 중인지 — 창 제목과 프로세스 이름으로 판단한다.
// 제목 규칙은 실제 CLI 에서 확인한 것만 쓴다(2026-11: Claude Code 2.1.322, Gemini CLI 0.32.1). Codex(0.165.0)는 제목에
// 상태를 넣지 않아(폴더 이름만) 프로세스 이름과 출력 흐름으로 추정한다.

export type AgentKind = 'claude' | 'codex' | 'gemini' | 'other'
/** 에이전트가 하는 일: 작업 중 · 사용자 입력이 필요함 · 다음 지시를 기다림 */
export type Activity = 'working' | 'attention' | 'idle'

export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', other: '기타' }

/** 원격 tmux 가 내보내는 제목의 접두사 — src-tauri/src/commands/pty.rs 의 TMUX_TITLE_FORMAT("minmo:<프로그램>:<제목>")과 짝이다 */
export const TMUX_TITLE_PREFIX = 'minmo:'

/** 창 제목 → (tmux 가 알려 준 프로그램 이름, 프로그램이 정한 제목). tmux 형식이 아니면 program 은 undefined */
export function parseTitle(raw: string): { program?: string; title: string } {
  if (!raw.startsWith(TMUX_TITLE_PREFIX)) return { title: raw }
  const rest = raw.slice(TMUX_TITLE_PREFIX.length)
  const sep = rest.indexOf(':')
  return sep < 0 ? { program: rest, title: '' } : { program: rest.slice(0, sep), title: rest.slice(sep + 1) }
}

export type TitleSignal = { agent: AgentKind; activity: Activity; label: string }

/**
 * 제목 앞의 상태 글자로 에이전트와 상태를 읽는다.
 *  - Claude Code: "✳ 이름" = 지시를 기다림, "◐ 이름"/"◑ 이름"(번갈아 바뀜) = 작업 중
 *  - Gemini CLI: "◇  Ready (폴더)" = 기다림, "✦  …" = 작업 중, "✋  …" = 사용자 확인이 필요함
 */
export function titleSignal(title: string): TitleSignal | null {
  const first = [...title][0]
  if (first === undefined) return null
  const label = title.slice(first.length).trim()
  switch (first) {
    case '✳':
      return { agent: 'claude', activity: 'idle', label }
    case '◐':
    case '◑':
    case '◒':
    case '◓':
      return { agent: 'claude', activity: 'working', label }
    case '◇':
      return { agent: 'gemini', activity: 'idle', label }
    case '✦':
      return { agent: 'gemini', activity: 'working', label }
    case '✋':
      return { agent: 'gemini', activity: 'attention', label }
    default:
      return null
  }
}

/** 셸·터미널 자체에 딸린 프로세스 — 이것만 있으면 "아무것도 안 돌고 있음" 이다 */
const SHELLS = new Set(['powershell', 'pwsh', 'cmd', 'conhost', 'openconsole', 'bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'login', 'sudo', 'su', 'tmux', 'ssh', 'winpty-agent', 'wslhost', 'wsl'])

const baseName = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/^-/, '')

export type ProgramGuess = { agent: AgentKind; program: string }

/**
 * 프로세스 이름들(이 PC 는 셸의 자손 전부, 원격 tmux 는 지금 앞에서 도는 프로그램 하나) → 에이전트.
 * 셸뿐이면 null. Gemini 는 node 로만 보이므로 여기서는 '기타(node)' 가 되고, 제목으로 Gemini 임을 안다.
 */
export function guessProgram(names: readonly string[]): ProgramGuess | null {
  const progs = names.map(baseName).filter((n) => n !== '' && !SHELLS.has(n))
  if (progs.length === 0) return null
  for (const kind of ['claude', 'codex', 'gemini'] as const) {
    if (progs.some((n) => n === kind || n.startsWith(`${kind}-`))) return { agent: kind, program: kind }
  }
  // 여러 개면 이름순으로 첫 번째 — 프로세스 목록의 순서가 바뀌어도 같은 이름을 고르게
  return { agent: 'other', program: [...progs].sort()[0] }
}
