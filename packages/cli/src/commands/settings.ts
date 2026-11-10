// 보일 저장소 선택·설정 편집 — 서버 모드는 데스크탑과 같은 서버 값, 로컬 모드는 이 기기의 로컬 값(서버 사본 위에 덮음)
import { readFile } from 'node:fs/promises'

import type { SettingsField, SettingsScope } from '@minmo/api-client'
import { SETTING_FIELDS, toggleOwnerAll, toggleRepo } from '@minmo/core'

import type { SelectionOrigin } from '../backend'
import { CliError, toCliError } from '../context'
import type { Ctx } from '../context'
import { parseRepo } from '../refs'

const ORIGIN_LABEL: Record<SelectionOrigin, string> = {
  server: '서버(데스크탑과 공유)',
  local: '로컬(이 기기)',
  copy: '서버 사본',
  default: '고른 적 없음',
}

export async function reposList(ctx: Ctx): Promise<void> {
  await ctx.data.ready()
  const { repos, origin } = await ctx.data.getSelection()
  if (ctx.mode === 'local') ctx.out.log(`[로컬 모드 · ${ORIGIN_LABEL[origin]}]`)
  if (repos === null) return ctx.out.log('모든 저장소를 표시합니다 (`minmo repos add owner/repo` 로 고를 수 있습니다)')
  if (repos.length === 0) return ctx.out.log('고른 저장소가 없습니다 — worktree 가 있는 저장소만 보입니다')
  for (const r of repos) ctx.out.log(r)
}

function applyEntry(sel: string[], entry: string, on: boolean): string[] {
  const t = entry.trim()
  if (/^[^/\s]+\/\*$/.test(t)) return toggleOwnerAll(sel, t.slice(0, -2), on)
  const { owner, repo } = parseRepo(t)
  return toggleRepo(sel, owner, repo, on)
}

const savedText = (ctx: Ctx, saved: string[] | null) =>
  `보일 저장소${ctx.mode === 'local' ? '(로컬)' : ''}: ${saved === null ? '(전체)' : saved.join(', ') || '(없음)'}`

export async function reposAdd(ctx: Ctx, entries: string[]): Promise<void> {
  await ctx.data.ready()
  const saved = await ctx.data.updateSelection((cur) => entries.reduce((s, e) => applyEntry(s, e, true), cur ?? []))
  ctx.out.log(savedText(ctx, saved))
}

export async function reposRemove(ctx: Ctx, entries: string[]): Promise<void> {
  await ctx.data.ready()
  const saved = await ctx.data.updateSelection((cur) => {
    if (cur === null) throw new CliError('지금은 모든 저장소를 표시 중입니다 — 먼저 `minmo repos add` 로 볼 저장소를 고르세요')
    return entries.reduce((s, e) => applyEntry(s, e, false), cur)
  })
  ctx.out.log(savedText(ctx, saved))
}

export async function reposAll(ctx: Ctx): Promise<void> {
  await ctx.data.ready()
  await ctx.data.updateSelection(() => null)
  ctx.out.log(`모든 저장소를 표시합니다${ctx.mode === 'local' ? '(로컬)' : ''}`)
}

/** 로컬 모드: 로컬에서 고른 값을 지우고 서버 사본으로 돌아간다 */
export async function reposReset(ctx: Ctx): Promise<void> {
  await ctx.data.resetSelection()
  const { repos, origin } = await ctx.data.getSelection()
  ctx.out.log(`로컬 선택을 지웠습니다 — ${ORIGIN_LABEL[origin]}: ${repos === null ? '(전체)' : repos.join(', ') || '(없음)'}`)
}

export const SETTING_KEYS = SETTING_FIELDS

export type ScopeOpts = { org?: string; project?: string }

function scopeOf(o: ScopeOpts): SettingsScope {
  if (o.org && o.project) throw new CliError('--org 와 --project 는 함께 쓸 수 없습니다', 2)
  if (o.org) return { kind: 'org', owner: o.org }
  if (o.project) return { kind: 'project', ...parseRepo(o.project) }
  return { kind: 'global' }
}

const scopeLabel = (ctx: Ctx, s: SettingsScope) =>
  `${ctx.mode === 'local' ? '로컬 ' : ''}${s.kind === 'global' ? '전역' : s.kind === 'org' ? `조직 ${s.owner}` : `프로젝트 ${s.owner}/${s.repo}`}`

/** null 의 뜻: 서버 모드는 상속, 로컬 모드는 로컬 값 없음(서버 사본·기본값) */
const unsetText = (ctx: Ctx) => (ctx.mode === 'local' ? '(사본/기본값)' : '(상속)')

export async function configGet(ctx: Ctx, opts: ScopeOpts & { effective?: string; json?: boolean }): Promise<void> {
  await ctx.data.ready()
  if (opts.effective) {
    const { owner, repo } = parseRepo(opts.effective)
    const eff = await ctx.data.getEffective(owner, repo).catch((e: unknown) => {
      throw toCliError(e, ctx.server)
    })
    if (opts.json) return ctx.out.log(JSON.stringify(eff, null, 2))
    for (const k of SETTING_KEYS) ctx.out.log(`${k} = ${JSON.stringify(eff.values[k])}  (${eff.sources[k]})`)
    return
  }
  const scope = scopeOf(opts)
  const rec = await ctx.data.getScope(scope)
  if (opts.json) return ctx.out.log(JSON.stringify(rec, null, 2))
  ctx.out.log(`[${scopeLabel(ctx, scope)}]`)
  for (const k of SETTING_KEYS) ctx.out.log(`${k} = ${rec[k] === null ? unsetText(ctx) : JSON.stringify(rec[k])}`)
}

/**
 * 값 하나를 바꾼다.
 * value: 문자열, `@파일`(스크립트 등 여러 줄), `-`(서버 모드: 조직·프로젝트에서 상속으로 · 로컬 모드: 로컬 값 지움)
 */
export async function configSet(ctx: Ctx, key: string, value: string, opts: ScopeOpts): Promise<void> {
  if (!SETTING_KEYS.includes(key as SettingsField)) throw new CliError(`알 수 없는 설정입니다: ${key} (가능: ${SETTING_KEYS.join(', ')})`, 2)
  const scope = scopeOf(opts)
  await ctx.data.ready()
  const v = value === '-' ? null : value.startsWith('@') ? (await readFile(value.slice(1), 'utf8')).replace(/\r\n/g, '\n') : value
  await ctx.data.setSetting(scope, key as SettingsField, v)
  ctx.out.log(`[${scopeLabel(ctx, scope)}] ${key} = ${v === null ? unsetText(ctx) : JSON.stringify(v)}`)
}
