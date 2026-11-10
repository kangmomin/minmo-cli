// 보일 저장소 선택·설정 편집 (데스크탑과 같은 서버 값을 쓴다)
import { readFile } from 'node:fs/promises'

import { ApiError } from '@minmo/api-client'
import type { SettingsField, SettingsInput, SettingsScope } from '@minmo/api-client'
import { toggleOwnerAll, toggleRepo } from '@minmo/core'

import { CliError, requireLogin, serverErrorMessage } from '../context'
import type { Ctx } from '../context'
import { parseRepo } from '../refs'

export async function reposList(ctx: Ctx): Promise<void> {
  await requireLogin(ctx)
  const { repos } = await ctx.api.getVisibleRepos()
  if (repos === null) return ctx.out.log('모든 저장소를 표시합니다 (`minmo repos add owner/repo` 로 고를 수 있습니다)')
  if (repos.length === 0) return ctx.out.log('고른 저장소가 없습니다 — worktree 가 있는 저장소만 보입니다')
  for (const r of repos) ctx.out.log(r)
}

/** 읽고 → 바꾸고 → baseUpdatedAt 으로 저장. 다른 기기가 먼저 바꿨으면(409) 한 번 다시 시도한다 */
async function updateSelection(ctx: Ctx, change: (cur: string[] | null) => string[] | null): Promise<string[] | null> {
  for (let attempt = 0; ; attempt++) {
    const cur = await ctx.api.getVisibleRepos()
    try {
      return (await ctx.api.putVisibleRepos({ repos: change(cur.repos), baseUpdatedAt: cur.updatedAt })).repos
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict' && attempt === 0) continue
      if (e instanceof ApiError && e.code === 'invalid_visible_repos') throw new CliError('형식이 올바르지 않습니다 — "owner/repo" 또는 "owner/*"')
      throw new CliError(serverErrorMessage(e, ctx.server))
    }
  }
}

function applyEntry(sel: string[], entry: string, on: boolean): string[] {
  const t = entry.trim()
  if (/^[^/\s]+\/\*$/.test(t)) return toggleOwnerAll(sel, t.slice(0, -2), on)
  const { owner, repo } = parseRepo(t)
  return toggleRepo(sel, owner, repo, on)
}

export async function reposAdd(ctx: Ctx, entries: string[]): Promise<void> {
  await requireLogin(ctx)
  const saved = await updateSelection(ctx, (cur) => entries.reduce((s, e) => applyEntry(s, e, true), cur ?? []))
  ctx.out.log(`보일 저장소: ${saved?.join(', ') || '(없음)'}`)
}

export async function reposRemove(ctx: Ctx, entries: string[]): Promise<void> {
  await requireLogin(ctx)
  const saved = await updateSelection(ctx, (cur) => {
    if (cur === null) throw new CliError('지금은 모든 저장소를 표시 중입니다 — 먼저 `minmo repos add` 로 볼 저장소를 고르세요')
    return entries.reduce((s, e) => applyEntry(s, e, false), cur)
  })
  ctx.out.log(`보일 저장소: ${saved?.join(', ') || '(없음)'}`)
}

export async function reposAll(ctx: Ctx): Promise<void> {
  await requireLogin(ctx)
  await updateSelection(ctx, () => null)
  ctx.out.log('모든 저장소를 표시합니다')
}

export const SETTING_KEYS: SettingsField[] = [
  'branchTemplate',
  'etcBranchName',
  'worktreePath',
  'mainClonePath',
  'postCreateScript',
  'postCreateScriptPosix',
  'sparsePaths',
]

export type ScopeOpts = { org?: string; project?: string }

function scopeOf(o: ScopeOpts): SettingsScope {
  if (o.org && o.project) throw new CliError('--org 와 --project 는 함께 쓸 수 없습니다', 2)
  if (o.org) return { kind: 'org', owner: o.org }
  if (o.project) return { kind: 'project', ...parseRepo(o.project) }
  return { kind: 'global' }
}

const scopeLabel = (s: SettingsScope) => (s.kind === 'global' ? '전역' : s.kind === 'org' ? `조직 ${s.owner}` : `프로젝트 ${s.owner}/${s.repo}`)

export async function configGet(ctx: Ctx, opts: ScopeOpts & { effective?: string; json?: boolean }): Promise<void> {
  await requireLogin(ctx)
  if (opts.effective) {
    const { owner, repo } = parseRepo(opts.effective)
    const eff = await ctx.api.getEffective(owner, repo)
    if (opts.json) return ctx.out.log(JSON.stringify(eff, null, 2))
    for (const k of SETTING_KEYS) ctx.out.log(`${k} = ${JSON.stringify(eff.values[k])}  (${eff.sources[k]})`)
    return
  }
  const scope = scopeOf(opts)
  const rec = await ctx.api.getSettings(scope)
  if (opts.json) return ctx.out.log(JSON.stringify(rec, null, 2))
  ctx.out.log(`[${scopeLabel(scope)}]`)
  for (const k of SETTING_KEYS) ctx.out.log(`${k} = ${rec[k] === null ? '(상속)' : JSON.stringify(rec[k])}`)
}

/**
 * 값 하나를 바꾼다. 서버 PUT 은 레코드 전체 교체라 현재 값을 읽어 그 키만 바꿔 보낸다.
 * value: 문자열, `@파일`(스크립트 등 여러 줄), `-`(조직·프로젝트에서 상속으로)
 */
export async function configSet(ctx: Ctx, key: string, value: string, opts: ScopeOpts): Promise<void> {
  await requireLogin(ctx)
  if (!SETTING_KEYS.includes(key as SettingsField)) throw new CliError(`알 수 없는 설정입니다: ${key} (가능: ${SETTING_KEYS.join(', ')})`, 2)
  const scope = scopeOf(opts)
  let v: string | null
  if (value === '-') {
    if (scope.kind === 'global') throw new CliError('전역 설정은 상속(-)할 수 없습니다', 2)
    v = null
  } else if (value.startsWith('@')) {
    v = (await readFile(value.slice(1), 'utf8')).replace(/\r\n/g, '\n')
  } else {
    v = value
  }
  const rec = await ctx.api.getSettings(scope)
  const input: SettingsInput = {}
  for (const k of SETTING_KEYS) input[k] = rec[k]
  input[key as SettingsField] = v
  try {
    await ctx.api.putSettings(scope, input)
  } catch (e) {
    if (e instanceof ApiError && e.field) throw new CliError(`${e.field} 값이 올바르지 않습니다(${e.code})`)
    throw new CliError(serverErrorMessage(e, ctx.server))
  }
  ctx.out.log(`[${scopeLabel(scope)}] ${key} = ${v === null ? '(상속)' : JSON.stringify(v)}`)
}
