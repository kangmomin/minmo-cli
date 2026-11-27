import { create } from 'zustand'

import type { RecentIssue } from '@minmo/core'

import type { LaunchKind } from '../agents/launch'

export const TAKER_STORAGE_KEY = 'minmo-taker'

export type TakerAuthor = 'me' | 'writers' | 'anyone'
export type TakerStep = { kind: LaunchKind; command: string; prompt: string }
export type TakerRepoConfig = { enabled: boolean; author: TakerAuthor; catchUp: boolean; steps: TakerStep[]; baseline: number | null }
export type TakerStatus = 'queued' | 'preparing' | 'running' | 'done' | 'manualNext' | 'stopped' | 'failed' | 'interrupted'
export type TakerRun = {
  id: string
  repoKey: string
  owner: string
  repo: string
  number: number
  title: string
  url: string
  issueId: string | null
  steps: TakerStep[]
  step: number
  status: TakerStatus
  paneId: string | null
  assigned: boolean
  note: string | null
  error: string | null
  foundAt: number
  updatedAt: number
}
export type TakerCheck = { at: number; error: string | null }
export type TakerPersisted = { repos: Record<string, TakerRepoConfig>; taken: Record<string, number[]>; runs: TakerRun[] }

export interface TakerState extends TakerPersisted {
  lastCheck: Record<string, TakerCheck>
  saveConfig(key: string, cfg: TakerRepoConfig): void
  setBaseline(key: string, n: number, cfg: TakerRepoConfig): boolean
  addRuns(key: string, issues: readonly RecentIssue[], cfg: TakerRepoConfig): boolean
  updateRun(id: string, patch: Partial<TakerRun>): void
}

export const DEFAULT_TAKER_STEPS: readonly TakerStep[] = []

export function defaultTakerConfig(): TakerRepoConfig {
  throw new Error('not implemented')
}

export function sanitize(_raw: unknown): TakerPersisted {
  throw new Error('not implemented')
}

const notImplemented = (): never => {
  throw new Error('not implemented')
}

export const useTakerStore = create<TakerState>()(() => ({
  repos: {},
  taken: {},
  runs: [],
  lastCheck: {},
  saveConfig: notImplemented,
  setBaseline: notImplemented,
  addRuns: notImplemented,
  updateRun: notImplemented,
}))
