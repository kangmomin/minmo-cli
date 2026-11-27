import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { StateStorage } from 'zustand/middleware'

import type { RecentIssue } from '@minmo/core'

import { isPrimaryWindow } from '../../lib/windowScope'
import { useSessionStore } from '../../store/session'
import { LAUNCH_KINDS } from '../agents/launch'
import type { LaunchKind } from '../agents/launch'
import { pickCandidates } from './taker'

export const TAKER_STORAGE_KEY = 'minmo-taker'

export type TakerAuthor = 'me' | 'writers' | 'anyone'
export type TakerStep = { kind: LaunchKind; command: string; prompt: string }
export type TakerRepoConfig = {
  enabled: boolean
  author: TakerAuthor
  catchUp: boolean
  steps: TakerStep[]
  baseline: number | null
  owner?: string
  repo?: string
}
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

export const DEFAULT_TAKER_STEPS: readonly TakerStep[] = [
  { kind: 'claude', command: 'claude {prompt}', prompt: '/common:ready-for-impl {issue}' },
  { kind: 'claude', command: 'claude --continue {prompt}', prompt: '/common:start-workflow 위 Spec으로 구현' },
]

const copySteps = (steps: readonly TakerStep[]): TakerStep[] => steps.map((s) => ({ ...s }))

export function defaultTakerConfig(): TakerRepoConfig {
  return { enabled: false, author: 'me', catchUp: false, steps: copySteps(DEFAULT_TAKER_STEPS), baseline: null }
}

const AUTHORS: readonly TakerAuthor[] = ['me', 'writers', 'anyone']
const STATUSES: readonly TakerStatus[] = ['queued', 'preparing', 'running', 'done', 'manualNext', 'stopped', 'failed', 'interrupted']
const FINISHED: readonly TakerStatus[] = ['done', 'stopped', 'failed', 'interrupted']
const KEEP_FINISHED = 30

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'

function sanitizeStep(v: unknown): TakerStep | null {
  if (!isRecord(v) || !LAUNCH_KINDS.includes(v.kind as LaunchKind) || typeof v.command !== 'string' || typeof v.prompt !== 'string') return null
  return { kind: v.kind as LaunchKind, command: v.command, prompt: v.prompt }
}

function sanitizeConfig(v: Record<string, unknown>): TakerRepoConfig {
  const d = defaultTakerConfig()
  const steps = Array.isArray(v.steps) ? v.steps.map(sanitizeStep).filter((s): s is TakerStep => s !== null) : []
  const cfg: TakerRepoConfig = {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : d.enabled,
    author: AUTHORS.includes(v.author as TakerAuthor) ? (v.author as TakerAuthor) : d.author,
    catchUp: typeof v.catchUp === 'boolean' ? v.catchUp : d.catchUp,
    steps: steps.length > 0 ? steps : d.steps,
    baseline: isCount(v.baseline) ? v.baseline : null,
  }
  if (typeof v.owner === 'string' && typeof v.repo === 'string') {
    cfg.owner = v.owner
    cfg.repo = v.repo
  }
  return cfg
}

function sanitizeRun(v: unknown): TakerRun | null {
  if (!isRecord(v) || !Array.isArray(v.steps)) return null
  const steps = v.steps.map(sanitizeStep)
  if (steps.some((s) => s === null)) return null
  if (typeof v.id !== 'string' || typeof v.repoKey !== 'string' || typeof v.owner !== 'string' || typeof v.repo !== 'string') return null
  if (!isCount(v.number) || typeof v.title !== 'string' || typeof v.url !== 'string' || !isStringOrNull(v.issueId)) return null
  if (!isCount(v.step) || !STATUSES.includes(v.status as TakerStatus) || !isStringOrNull(v.paneId) || typeof v.assigned !== 'boolean') return null
  if (!isStringOrNull(v.note) || !isStringOrNull(v.error) || !isTime(v.foundAt) || !isTime(v.updatedAt)) return null
  return {
    id: v.id,
    repoKey: v.repoKey,
    owner: v.owner,
    repo: v.repo,
    number: v.number,
    title: v.title,
    url: v.url,
    issueId: v.issueId,
    steps: steps as TakerStep[],
    step: v.step,
    status: v.status as TakerStatus,
    paneId: v.paneId,
    assigned: v.assigned,
    note: v.note,
    error: v.error,
    foundAt: v.foundAt,
    updatedAt: v.updatedAt,
  }
}

export function sanitize(raw: unknown): TakerPersisted {
  if (!isRecord(raw)) return { repos: {}, taken: {}, runs: [] }
  const repos: Record<string, TakerRepoConfig> = {}
  if (isRecord(raw.repos)) for (const [k, v] of Object.entries(raw.repos)) if (isRecord(v)) repos[k] = sanitizeConfig(v)
  const taken: Record<string, number[]> = {}
  if (isRecord(raw.taken)) for (const [k, v] of Object.entries(raw.taken)) if (Array.isArray(v)) taken[k] = v.filter(isCount)
  const runs = Array.isArray(raw.runs) ? raw.runs.map(sanitizeRun).filter((r): r is TakerRun => r !== null) : []
  return { repos, taken, runs }
}

function pruneFinished(runs: TakerRun[]): TakerRun[] {
  const byRepo = new Map<string, TakerRun[]>()
  for (const r of runs) if (FINISHED.includes(r.status)) byRepo.set(r.repoKey, [...(byRepo.get(r.repoKey) ?? []), r])
  const drop = new Set<TakerRun>()
  for (const list of byRepo.values()) for (const r of [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(KEEP_FINISHED)) drop.add(r)
  return drop.size === 0 ? runs : runs.filter((r) => !drop.has(r))
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf('/')
  return [key.slice(0, i), key.slice(i + 1)]
}

const primaryOnlyStorage: StateStorage = {
  getItem: (name) => localStorage.getItem(name),
  // Why: 보조 창이 옛 값으로 주 창의 기록을 덮지 않게, 쓰기는 주 창만 한다(호출 때 판정)
  setItem: (name, value) => {
    if (isPrimaryWindow()) localStorage.setItem(name, value)
  },
  removeItem: (name) => {
    if (isPrimaryWindow()) localStorage.removeItem(name)
  },
}

export const useTakerStore = create<TakerState>()(
  persist(
    (set, get) => ({
      repos: {},
      taken: {},
      runs: [],
      lastCheck: {},
      saveConfig: (key, cfg) =>
        set((s) => {
          const prev = s.repos[key]
          const wasOn = prev?.enabled === true
          // Why: 켤 때만 기준 번호를 새로 잡는다. 켠 채 저장하면 그 사이 확인이 올린 기준 번호를 지킨다
          const baseline = cfg.enabled && !wasOn ? null : prev ? prev.baseline : cfg.baseline
          const now = Date.now()
          const runs = wasOn && !cfg.enabled ? s.runs.map((r) => (r.repoKey === key && r.status === 'queued' ? { ...r, status: 'stopped' as const, updatedAt: now } : r)) : s.runs
          return { repos: { ...s.repos, [key]: { ...cfg, steps: copySteps(cfg.steps), baseline } }, runs }
        }),
      setBaseline: (key, n, cfg) => {
        const s = get()
        if (s.repos[key] !== cfg) return false
        const baseline = Math.max(n, cfg.baseline ?? 0, ...(s.taken[key] ?? []))
        set({ repos: { ...s.repos, [key]: { ...cfg, baseline } } })
        return true
      },
      addRuns: (key, issues, cfg) => {
        const s = get()
        if (s.repos[key] !== cfg) return false
        const login = useSessionStore.getState().me?.githubLogin ?? ''
        const picked = cfg.baseline === null ? [] : pickCandidates(issues, { author: cfg.author, baseline: cfg.baseline, taken: s.taken[key] ?? [], login })
        const [owner, repo] = cfg.owner !== undefined && cfg.repo !== undefined ? [cfg.owner, cfg.repo] : splitKey(key)
        const now = Date.now()
        const added: TakerRun[] = []
        for (const i of [...picked].sort((a, b) => a.number - b.number)) {
          if (added.some((r) => r.number === i.number)) continue
          added.push({
            id: `${key}#${i.number}-${now}`,
            repoKey: key,
            owner,
            repo,
            number: i.number,
            title: i.title,
            url: i.htmlUrl,
            issueId: null,
            steps: copySteps(cfg.steps),
            step: 0,
            status: 'queued',
            paneId: null,
            assigned: false,
            note: null,
            error: null,
            foundAt: now,
            updatedAt: now,
          })
        }
        const taken = [...(s.taken[key] ?? []), ...added.map((r) => r.number)]
        const base = cfg.baseline
        set({ runs: pruneFinished([...s.runs, ...added]), taken: { ...s.taken, [key]: base === null ? taken : taken.filter((n) => n > base) } })
        return true
      },
      updateRun: (id, patch) =>
        set((s) => {
          const i = s.runs.findIndex((r) => r.id === id)
          if (i < 0) return s
          const cur = s.runs[i]
          if ((Object.keys(patch) as (keyof TakerRun)[]).every((k) => cur[k] === patch[k])) return s
          const runs = [...s.runs]
          runs[i] = { ...cur, ...patch, updatedAt: patch.updatedAt ?? Date.now() }
          return { runs }
        }),
    }),
    {
      name: TAKER_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => primaryOnlyStorage),
      partialize: (s) => ({ repos: s.repos, taken: s.taken, runs: s.runs }),
      merge: (persisted, current) => ({ ...current, ...sanitize(persisted) }),
    },
  ),
)
