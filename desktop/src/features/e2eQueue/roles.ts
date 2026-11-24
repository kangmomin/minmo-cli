// E2E 큐의 역할(① E2E 실행 ② 엣지케이스 찾기 ③ 엣지케이스 기반 테스트) 설정과 명령 만들기 — 순수 함수
import { buildCommand, quoteArg } from '../agents/launch'
import type { BuiltCommand, LaunchKind, ShellKind } from '../agents/launch'

export const E2E_ROLES = ['run', 'edge', 'verify'] as const
export type E2eRole = (typeof E2E_ROLES)[number]

export type RoleKind = Exclude<LaunchKind, 'custom'>
export const ROLE_KINDS: readonly RoleKind[] = ['claude', 'codex', 'gemini']
/** model 이 빈 값이면 CLI 기본값(모델 인자 없음) */
export type RoleConfig = { kind: RoleKind; model: string; prompt: string }
export type E2eRoles = Record<E2eRole, RoleConfig>

export const ROLE_LABEL: Record<E2eRole, string> = { run: '① E2E 실행', edge: '② 엣지케이스 찾기', verify: '③ 엣지케이스 기반 테스트' }

// 결과 파일은 마지막에 한 번만 쓰게 한다 — 파일이 생기고 에이전트가 쉬면 다음 단계로 넘어가므로(AC-05), 묻는 도중에 쓰면 미완성 결과가 넘어간다
const WRITE_LAST = '모든 작업과 질문이 끝난 뒤 마지막에 결과를 {out} 파일에 한 번에 쓴다. 사용자에게 물을 것이 있으면 파일을 쓰지 말고 먼저 묻는다.'
// 결과 폴더는 .gitignore 로 숨겨져 있어 파일 도구(gemini 등)가 읽지 않을 수 있다(A-14)
const READ_PREV = '앞 단계 결과 파일({prev})은 셸 명령(cat 또는 Get-Content)으로 읽는다.'

export const DEFAULT_ROLES: E2eRoles = {
  run: {
    kind: 'claude',
    model: '',
    prompt: [
      '이슈 {issue} 의 작업 폴더에서 E2E 테스트를 실행한다.',
      '실행한 명령, 통과·실패한 테스트, 실패 원인을 마크다운으로 정리한다.',
      WRITE_LAST,
    ].join('\n'),
  },
  edge: {
    kind: 'claude',
    model: '',
    prompt: [
      '이슈 {issue} 의 변경 사항에서 E2E 테스트가 다루지 않은 엣지 케이스를 찾는다. 코드는 고치지 않는다.',
      READ_PREV,
      '엣지 케이스마다 재현 조건과 기대 동작을 마크다운 목록으로 정리한다.',
      WRITE_LAST,
    ].join('\n'),
  },
  verify: {
    kind: 'claude',
    model: '',
    prompt: [
      '이슈 {issue} 에서 찾은 엣지 케이스로 E2E 테스트를 작성하고 실행한다.',
      READ_PREV,
      '엣지 케이스마다 추가한 테스트, 결과(통과·실패), 실패 원인을 마크다운으로 정리한다.',
      WRITE_LAST,
    ].join('\n'),
  },
}

const RESULT_NAME: Record<E2eRole, string> = { run: '1-run.md', edge: '2-edge-cases.md', verify: '3-verify.md' }

/** 지시문 자리표시: {issue} · {out}(이 단계 결과 파일) · {prev}(앞 단계 결과 파일들) */
export type PromptContext = { issue: string; out: string; prev: string }

/** 모델 입력 패턴(A-6) — `-` 로 시작하지 않는다(옵션 주입 방지) */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/

/** worktree 기준 상대 경로(A-1) */
export function resultFile(jobId: string, role: E2eRole): string {
  return `.minmo/e2e/${jobId}/${RESULT_NAME[role]}`
}

export function fillPrompt(template: string, ctx: PromptContext): string {
  return template.replace(/\{(issue|out|prev)\}/g, (_, key: keyof PromptContext) => ctx[key])
}

const MODEL_SLOT = '{model}'
const MODEL_FLAG: Record<RoleKind, string> = { claude: '--model', codex: '-m', gemini: '-m' }

/** 따옴표로 묶인 부분은 한 토큰으로 본다 — `& 'C:\Program Files\…\claude.cmd'` 처럼 경로에 공백이 있어도 */
function tokens(tpl: string): { text: string; end: number }[] {
  return [...tpl.matchAll(/(?:'[^']*'|"[^"]*"|[^\s'"])+/g)].map((m) => ({ text: m[0], end: m.index + m[0].length }))
}

/** 따옴표·경로·실행 파일 확장자를 떼고 CLI 이름과 같은가 */
function isCliToken(token: string, kind: RoleKind): boolean {
  const name = token.replace(/['"]/g, '').split(/[\\/]/).pop() ?? ''
  return name.replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase() === kind
}

/**
 * 명령 틀에 모델 인자를 넣는다(A-4). 모델이 비면 CLI 기본값이라 넣지 않는다.
 * ① `{model}` 자리 ② 이미 모델 옵션이 있으면 그대로 ③ CLI 이름 토큰 바로 뒤 ④ `{prompt}`(바로 앞 한 글자 옵션 포함) 앞 — 없으면 끝
 */
export function withModel(template: string, kind: RoleKind, model: string, shell: ShellKind): string {
  const value = model.trim()
  if (template.includes(MODEL_SLOT)) {
    if (value !== '') return template.split(MODEL_SLOT).join(quoteArg(value, shell))
    // 값 없는 옵션(`--model`)이 남으면 다음 인자를 모델로 먹는다 → 바로 앞 옵션도 함께 뺀다
    return template
      .replace(/(?:(?<=^|\s)--?[A-Za-z][\w-]*(?:\s+|=))?\{model\}/g, '')
      .replace(/ {2,}/g, ' ')
      .trim()
  }
  if (value === '' || template.trim() === '') return template
  const toks = tokens(template)
  if (toks.some((t) => t.text === '--model' || t.text === '-m' || t.text.startsWith('--model='))) return template
  const arg = `${MODEL_FLAG[kind]} ${quoteArg(value, shell)}`
  const cli = toks.find((t) => isCliToken(t.text, kind))
  if (cli) return `${template.slice(0, cli.end)} ${arg}${template.slice(cli.end)}`
  const slot = /(?:(?<=^|\s)-[A-Za-z]\s+)?\{prompt\}/.exec(template)
  if (slot) return `${template.slice(0, slot.index)}${arg} ${template.slice(slot.index)}`
  return `${template.trimEnd()} ${arg}`
}

/** 역할 설정 + 그 CLI 의 명령 틀(agentCommands) → 터미널에 넣을 한 줄(AC-04). 오류는 작업 실패 사유로 쓴다(EC-07) */
export function buildRoleCommand(cfg: RoleConfig, template: string, ctx: PromptContext, shell: ShellKind): BuiltCommand {
  return buildCommand(withModel(template, cfg.kind, cfg.model, shell), fillPrompt(cfg.prompt, ctx), shell)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sanitizeRole(value: unknown, fallback: RoleConfig): RoleConfig {
  if (!isRecord(value)) return fallback
  const kindOk = ROLE_KINDS.includes(value.kind as RoleKind)
  const modelOk = typeof value.model === 'string' && (value.model === '' || MODEL_RE.test(value.model))
  return {
    kind: kindOk ? (value.kind as RoleKind) : fallback.kind,
    // 모델은 그 CLI 의 값이라 CLI 가 기본값으로 바뀌면 함께 기본값으로 둔다
    model: kindOk && modelOk ? (value.model as string) : fallback.model,
    prompt: typeof value.prompt === 'string' ? value.prompt : fallback.prompt,
  }
}

/** 공유 동기화·저장 값에서 받은 역할 설정 — 알려진 유효 값만 받고 나머지는 기본값(EC-11) */
export function sanitizeRoles(value: unknown): E2eRoles {
  const src = isRecord(value) ? value : {}
  return {
    run: sanitizeRole(src.run, DEFAULT_ROLES.run),
    edge: sanitizeRole(src.edge, DEFAULT_ROLES.edge),
    verify: sanitizeRole(src.verify, DEFAULT_ROLES.verify),
  }
}
