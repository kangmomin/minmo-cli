import type { QueryClient } from '@tanstack/react-query'

import type { Platform } from '@minmo/api-client'
import type { GitHubClient } from '@minmo/core'

import type { TauriApi } from '../../lib/tauri'
import type { IssueActions } from '../issue/useWorktree'

export type TakerEngineDeps = {
  github: GitHubClient
  tauri: Pick<TauriApi, 'notify' | 'ptyWrite' | 'onPtyLink' | 'onPtyExit' | 'sshProbe'>
  actionsFor(alias: string | null): Pick<IssueActions, 'open'>
  queryClient: Pick<QueryClient, 'invalidateQueries'>
  getPlatform(): Platform
  now(): number
}

export type NextStepResult = 'started' | 'busy' | 'notReady'

export interface TakerEngine {
  start(now: number): void
  check(now: number): Promise<void>
  tick(now: number): Promise<void> | void
  stop(id: string): void
  restart(id: string): void
  nextStep(id: string): NextStepResult
  dispose(): void
}

const notImplemented = (): never => {
  throw new Error('not implemented')
}

export function createTakerEngine(_deps: TakerEngineDeps): TakerEngine {
  return {
    start: notImplemented,
    check: notImplemented,
    tick: notImplemented,
    stop: notImplemented,
    restart: notImplemented,
    nextStep: notImplemented,
    dispose: notImplemented,
  }
}
