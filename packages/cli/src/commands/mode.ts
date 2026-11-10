// 모드 전환: server(PC 의 minmo 서버, SSH 역터널) ↔ local(서버 없이 이 기기의 로컬 값 + 서버 사본)
import type { Effective, SettingsField, SettingsValues } from '@minmo/api-client'
import { SETTING_FIELDS } from '@minmo/core'

import { checkLogin, saveCopy } from '../backend'
import { CliError, serverErrorMessage } from '../context'
import type { Ctx } from '../context'
import { describeServer } from '../server'
import { updateConfig } from '../store'
import type { Mode } from '../store'

export const MODE_LABEL: Record<Mode, string> = { server: '서버 모드', local: '로컬 모드' }

/** 로컬에서 바꾼 설정 수(+보일 저장소) */
function localChanges(ctx: Ctx): number {
  const l = ctx.config.local
  const n = (o: object) => Object.keys(o).length
  return n(l.global) + Object.values(l.orgs).reduce((s, o) => s + n(o), 0) + Object.values(l.projects).reduce((s, o) => s + n(o), 0) + (l.visibleRepos !== undefined ? 1 : 0)
}

export function describeCopy(ctx: Ctx): string {
  const c = ctx.state.serverCopy
  if (!c.syncedAt) return '서버 사본 없음 — 로컬 값 외에는 기본값을 씁니다'
  const parts = [c.global ? '전역 설정' : '', c.visibleRepos !== undefined ? '보일 저장소' : '', `저장소 설정 ${Object.keys(ctx.state.effective).length}개`].filter(Boolean)
  return `서버 사본: ${parts.join('·')} (마지막 갱신 ${c.syncedAt})`
}

/**
 * 서버 값을 사본으로 받아 둔다 — 전역 설정, 보일 저장소, worktree 가 있거나 명시적으로 고른 저장소의 effective.
 * 서버에 닿지 않거나 로그인돼 있지 않으면 CliError.
 */
export async function syncServerCopy(ctx: Ctx): Promise<{ repos: number; failed: number }> {
  await checkLogin(ctx.api, ctx.creds, ctx.server)
  const fail = (e: unknown) => new CliError(serverErrorMessage(e, ctx.server))
  const [global, visible] = await Promise.all([ctx.api.getSettings({ kind: 'global' }), ctx.api.getVisibleRepos()]).catch((e: unknown) => {
    throw fail(e)
  })
  const targets = new Map<string, [string, string]>()
  for (const id of Object.keys(ctx.state.worktrees)) {
    const [owner, rest] = id.split('/')
    const repo = rest.split('#')[0]
    targets.set(`${owner}/${repo}`.toLowerCase(), [owner, repo])
  }
  for (const e of visible.repos ?? []) {
    const [owner, repo] = e.split('/')
    if (repo !== '*') targets.set(e, [owner, repo])
  }
  const effs: Record<string, Effective> = {}
  let failed = 0
  for (const [k, [owner, repo]] of targets) {
    try {
      effs[k] = await ctx.api.getEffective(owner, repo)
    } catch {
      failed++
    }
  }
  const values = Object.fromEntries(SETTING_FIELDS.map((f) => [f, global[f]])) as Record<SettingsField, string | null>
  const complete = SETTING_FIELDS.every((f) => typeof values[f] === 'string')
  await saveCopy(ctx, (s) => {
    if (complete) s.serverCopy.global = { ...(values as SettingsValues) }
    s.serverCopy.visibleRepos = visible.repos
    Object.assign(s.effective, effs)
  })
  return { repos: Object.keys(effs).length, failed }
}

export async function modeCmd(ctx: Ctx, target?: string): Promise<void> {
  if (target === undefined) {
    ctx.out.log(`현재: ${MODE_LABEL[ctx.mode]}`)
    if (ctx.mode === 'local') {
      ctx.out.log(`  로컬에서 바꾼 값 ${localChanges(ctx)}개 · ${describeCopy(ctx)}`)
      ctx.out.log('  서버 모드로: `minmo mode server`(역터널로 접속해야 합니다)')
    } else {
      ctx.out.log(`  서버: ${describeServer(ctx.server)}`)
      ctx.out.log('  서버 없이 쓰려면: `minmo mode local`')
    }
    return
  }
  if (target !== 'local' && target !== 'server') throw new CliError(`모드는 local 또는 server 입니다: ${target}`, 2)

  if (target === 'local') {
    // 전환하는 김에 서버에 닿으면 사본을 새로 받아 둔다(이미 로컬 모드여도 — 사본 갱신용)
    if (ctx.creds?.session) {
      try {
        const r = await syncServerCopy(ctx)
        ctx.out.log(`서버 사본을 갱신했습니다 — 전역 설정·보일 저장소·저장소 설정 ${r.repos}개${r.failed ? ` (실패 ${r.failed}개)` : ''}`)
      } catch (e) {
        ctx.out.log(`서버에서 사본을 받지 못했습니다(${e instanceof Error ? e.message : String(e)})`)
        ctx.out.log(`  ${describeCopy(ctx)}`)
      }
    } else {
      ctx.out.log(`로그인하지 않아 서버 사본을 받지 않았습니다 — ${describeCopy(ctx)}`)
    }
  }

  await updateConfig(ctx.paths, ctx.config, (c) => {
    c.mode = target
  })
  ctx.out.log(`${MODE_LABEL[target]}로 전환했습니다`)

  if (target === 'local') {
    ctx.out.log('  설정·보일 저장소는 로컬 값이 서버 사본보다 우선합니다(`minmo config`·`minmo repos` 는 로컬 값을 바꿉니다). 메모는 서버 모드에서만 씁니다')
  } else {
    try {
      const me = await checkLogin(ctx.api, ctx.creds, ctx.server)
      ctx.out.log(`  서버 연결·로그인 확인: ${me.githubLogin}`)
    } catch (e) {
      ctx.out.log(`  지금은 서버를 쓸 수 없습니다 — ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
