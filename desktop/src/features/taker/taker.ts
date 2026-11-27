import type { RecentIssue } from '@minmo/core'

import { PROCESS_POLL_MS } from '../agents/agentStore'
import type { TakerAuthor, TakerRun, TakerStep } from './takerStore'

export const TAKER_CHECK_MS = 300_000
export const TAKER_MAX_ACTIVE = 3
export const TAKER_EXIT_QUIET_MS = 2 * PROCESS_POLL_MS
export const TAKER_START_TIMEOUT_MS = 120_000

export type StepProgress = 'ended' | 'startTimeout' | 'wait'

export function renderPrompt(_template: string, _issue: { number: number; title: string; url: string }): string {
  throw new Error('not implemented')
}

export function riskyFlags(_command: string): string[] {
  throw new Error('not implemented')
}

export function pickCandidates(
  _issues: readonly RecentIssue[],
  _opts: { author: TakerAuthor; baseline: number; taken: readonly number[]; login: string },
): RecentIssue[] {
  throw new Error('not implemented')
}

export function validateSteps(_steps: readonly TakerStep[]): { error: string | null; steps: (string | null)[] } {
  throw new Error('not implemented')
}

export function isActive(_run: Pick<TakerRun, 'status'>): boolean {
  throw new Error('not implemented')
}

export function nextToStart(_runs: readonly TakerRun[], _hostReady: (run: TakerRun) => boolean): TakerRun[] {
  throw new Error('not implemented')
}

export function canWrite(_o: { shellSince: number | undefined; linkChangedAt: number | null | undefined; now: number }): boolean {
  throw new Error('not implemented')
}

export function stepProgress(_o: {
  seen: boolean
  lastSeenAt: number
  shellSince: number | undefined
  agentPresent: boolean
  wroteAt: number | null
  now: number
}): StepProgress {
  throw new Error('not implemented')
}
