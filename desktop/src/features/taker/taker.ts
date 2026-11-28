import type { RecentIssue } from '@minmo/core'

import { PROCESS_POLL_MS } from '../agents/agentStore'
import { buildCommand, oneLine } from '../agents/launch'
import type { TakerAuthor, TakerRun, TakerStep } from './takerStore'

export const TAKER_CHECK_MS = 300_000
export const TAKER_MAX_ACTIVE = 3
export const TAKER_EXIT_QUIET_MS = 2 * PROCESS_POLL_MS
export const TAKER_START_TIMEOUT_MS = 120_000

export type StepProgress = 'ended' | 'startTimeout' | 'wait'

export function renderPrompt(template: string, issue: { number: number; title: string; url: string }): string {
  const head = `#${issue.number} ${issue.title}`.trim()
  const values: Record<string, string> = {
    issue: `${head} (${issue.url})`,
    number: String(issue.number),
    title: issue.title,
    url: issue.url,
  }
  // Why: 한 번에 바꿔야 제목 안의 {url} 같은 글자가 다시 바뀌지 않는다. 함수로 넘겨 제목의 $& 도 그대로 둔다
  return template.replace(/\{(issue|number|title|url)\}/g, (_, key: string) => values[key])
}

const RISKY_FLAGS = ['--dangerously-skip-permissions', '--yolo', '-y', '--full-auto', '--dangerously-bypass-approvals-and-sandbox']
const BYPASS_MODE = '--permission-mode bypassPermissions'

export function riskyFlags(command: string): string[] {
  const tokens = oneLine(command).split(' ')
  const found: string[] = []
  tokens.forEach((tok, i) => {
    const flag = RISKY_FLAGS.includes(tok) ? tok : tok === '--permission-mode=bypassPermissions' || (tok === '--permission-mode' && tokens[i + 1] === 'bypassPermissions') ? BYPASS_MODE : null
    if (flag !== null && !found.includes(flag)) found.push(flag)
  })
  return found
}

const WRITER_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR']

export function pickCandidates(
  issues: readonly RecentIssue[],
  opts: { author: TakerAuthor; baseline: number; taken: readonly number[]; login: string },
): RecentIssue[] {
  const me = opts.login.toLowerCase()
  const taken = new Set(opts.taken)
  const authorOk = (i: RecentIssue) =>
    opts.author === 'anyone' ||
    (opts.author === 'me' ? me !== '' && i.author?.toLowerCase() === me : WRITER_ASSOCIATIONS.includes(i.authorAssociation ?? ''))
  return issues.filter(
    (i) =>
      i.state === 'open' &&
      i.number > opts.baseline &&
      !taken.has(i.number) &&
      authorOk(i) &&
      (i.assignees.length === 0 || i.assignees.some((a) => a.toLowerCase() === me)),
  )
}

export function validateSteps(steps: readonly TakerStep[]): { error: string | null; steps: (string | null)[] } {
  if (steps.length === 0) return { error: '단계를 하나 이상 두세요', steps: [] }
  return {
    error: null,
    steps: steps.map((s) => {
      const built = buildCommand(s.command, s.prompt, 'posix')
      if (!built.ok) return built.error
      const prompt = oneLine(s.prompt)
      // Why: 지시문이 - 로 시작하면(제목으로 시작해 제목이 - 로 시작해도) 에이전트가 옵션으로 읽는다
      if (prompt.startsWith('{title}') || prompt.startsWith('-')) return '지시문을 {title} 이나 - 로 시작하지 마세요 — 에이전트가 옵션으로 읽을 수 있습니다'
      return null
    }),
  }
}

export function isActive(run: Pick<TakerRun, 'status'>): boolean {
  return run.status === 'preparing' || run.status === 'running' || run.status === 'manualNext'
}

export function nextToStart(runs: readonly TakerRun[], hostReady: (run: TakerRun) => boolean): TakerRun[] {
  let free = TAKER_MAX_ACTIVE - runs.filter(isActive).length
  const out: TakerRun[] = []
  for (const r of runs.filter((x) => x.status === 'queued').sort((a, b) => a.foundAt - b.foundAt)) {
    if (free <= 0) break
    // Why: hostReady 는 호스트 연결 확인을 시작할 수 있어, 시작할 자리가 있는 만큼만 묻는다
    if (!hostReady(r)) continue
    out.push(r)
    free--
  }
  return out
}

export function canWrite(o: { shellSince: number | undefined; linkChangedAt: number | null | undefined; now: number }): boolean {
  return o.shellSince !== undefined && o.now - o.shellSince >= TAKER_EXIT_QUIET_MS && o.now - (o.linkChangedAt ?? 0) >= TAKER_EXIT_QUIET_MS
}

export function stepProgress(o: {
  seen: boolean
  lastSeenAt: number
  shellSince: number | undefined
  agentPresent: boolean
  wroteAt: number | null
  now: number
}): StepProgress {
  if (o.seen && !o.agentPresent && o.shellSince !== undefined && o.shellSince >= o.lastSeenAt && o.now - o.shellSince >= TAKER_EXIT_QUIET_MS) return 'ended'
  if (!o.seen && o.wroteAt !== null && o.now - o.wroteAt >= TAKER_START_TIMEOUT_MS) return 'startTimeout'
  return 'wait'
}
