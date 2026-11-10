// 서버 모드 / 로컬 모드 — 전환·서버 사본·로컬 값 우선순위·모드별 명령 동작
import { readFile } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '@minmo/api-client'
import type { Effective, SettingsRecord } from '@minmo/api-client'
import { DEFAULT_SETTINGS, worktreeId } from '@minmo/core'
import { createFakeHost } from '@minmo/core/testing'

import { CliError, createContext, GITHUB_AUTH_REQUIRED } from '../context'
import type { NodeHost } from '../host/node'
import { createFakeApi, createTestCtx, EFFECTIVE, EMPTY_RECORD } from '../test/fakes'
import { doctor } from './account'
import { ls, note, openIssue } from './issues'
import { modeCmd } from './mode'
import { configGet, configSet, reposAdd, reposList, reposReset } from './settings'

const offline = () => Promise.reject(new ApiError({ status: 0, code: 'network_error' }))
const readConfig = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

const GLOBAL: SettingsRecord = { ...EMPTY_RECORD, ...DEFAULT_SETTINGS, worktreePath: '~/copy/{owner}/{repo}/{branch}', updatedAt: 't' }
const PROJECT_EFF: Effective = {
  values: { ...EFFECTIVE.values, sparsePaths: 'desktop', branchTemplate: 'stale/{number}' },
  sources: { ...EFFECTIVE.sources, sparsePaths: 'project' },
}

describe('minmo mode', () => {
  it('local: 서버에 닿으면 사본(전역·보일 저장소·worktree/고른 저장소 설정)을 받고 전환한다', async () => {
    const ctx = await createTestCtx({
      api: {
        getSettings: async () => GLOBAL,
        getVisibleRepos: async () => ({ repos: ['acme/widgets', 'octocat/*'], updatedAt: 't' }),
      },
    })
    ctx.state.worktrees[worktreeId('octocat', 'dotfiles', '1')] = { path: '/w/1', branch: 'b' }
    await modeCmd(ctx, 'local')
    expect(ctx.api.getEffective.mock.calls.map((c) => c.join('/')).sort()).toEqual(['acme/widgets', 'octocat/dotfiles'])
    const state = JSON.parse(await readFile(ctx.paths.state, 'utf8'))
    expect(state.serverCopy).toMatchObject({ global: { worktreePath: '~/copy/{owner}/{repo}/{branch}' }, visibleRepos: ['acme/widgets', 'octocat/*'] })
    expect(Object.keys(state.effective).sort()).toEqual(['acme/widgets', 'octocat/dotfiles'])
    expect((await readConfig(ctx.paths.config)).mode).toBe('local')
    expect(ctx.logs.join('\n')).toContain('서버 사본을 갱신했습니다 — 전역 설정·보일 저장소·저장소 설정 2개')
  })

  it('local: 서버에 닿지 않아도 전환한다(사본 그대로) — server 로 돌아갈 때 점검 실패는 안내만', async () => {
    const ctx = await createTestCtx({ api: { me: offline } })
    await modeCmd(ctx, 'local')
    expect(ctx.logs.join('\n')).toContain('서버에서 사본을 받지 못했습니다')
    expect((await readConfig(ctx.paths.config)).mode).toBe('local')
    await modeCmd(ctx, 'server')
    expect((await readConfig(ctx.paths.config)).mode).toBe('server')
    expect(ctx.logs.join('\n')).toContain('지금은 서버를 쓸 수 없습니다')
  })

  it('인자 없이 현재 모드, 잘못된 값은 종료 코드 2', async () => {
    const ctx = await createTestCtx({ mode: 'local' })
    await modeCmd(ctx)
    expect(ctx.logs[0]).toBe('현재: 로컬 모드')
    expect(ctx.logs[1]).toContain('서버 사본 없음')
    await expect(modeCmd(ctx, 'ssh')).rejects.toMatchObject({ exitCode: 2 })
  })
})

describe('로컬 모드', () => {
  it('ls·open 은 로그인 없이, 서버를 부르지 않는다 — worktree 설정은 로컬 계산값', async () => {
    const ctx = await createTestCtx({ mode: 'local', loggedIn: false })
    await ls(ctx, undefined, {})
    expect(ctx.logs).toEqual(['octocat/dotfiles', 'Acme/Widgets', 'Acme/gadgets'])
    const eff = vi.spyOn(ctx.data, 'getEffective')
    // 가짜 호스트라 준비 도중 실패해도 된다 — 설정을 로컬 출처에서 읽는지만 본다
    await openIssue(ctx, 'acme/widgets#7', { attach: false }).catch(() => undefined)
    expect(eff).toHaveBeenCalledWith('Acme', 'Widgets')
    for (const fn of [ctx.api.me, ctx.api.getVisibleRepos, ctx.api.getEffective, ctx.api.getGithubToken]) expect(fn).not.toHaveBeenCalled()
  })

  it('effective: 기본값 ← 사본 전역 ← 사본 저장소(조직·프로젝트 값만) ← 로컬 전역 ← 로컬 조직 ← 로컬 프로젝트', async () => {
    const ctx = await createTestCtx({ mode: 'local' })
    const { updatedAt: _u, ...globalValues } = GLOBAL
    ctx.state.serverCopy = { global: globalValues as typeof DEFAULT_SETTINGS, syncedAt: 't' }
    ctx.state.effective['acme/widgets'] = PROJECT_EFF
    await configSet(ctx, 'etcBranchName', 'misc', {})
    await configSet(ctx, 'postCreateScriptPosix', 'npm ci', { org: 'ACME' })
    await configSet(ctx, 'mainClonePath', '~/m/{owner}/{repo}', { project: 'Acme/Widgets' })
    const eff = await ctx.data.getEffective('Acme', 'Widgets')
    expect(eff.values).toMatchObject({
      worktreePath: '~/copy/{owner}/{repo}/{branch}',
      sparsePaths: 'desktop',
      // 저장소 사본의 전역 값(stale)은 전역 사본이 있으면 쓰지 않는다
      branchTemplate: DEFAULT_SETTINGS.branchTemplate,
      etcBranchName: 'misc',
      postCreateScriptPosix: 'npm ci',
      mainClonePath: '~/m/{owner}/{repo}',
    })
    expect(eff.sources).toMatchObject({
      worktreePath: '서버 사본',
      sparsePaths: '서버 사본',
      etcBranchName: '로컬 전역',
      postCreateScriptPosix: '로컬 조직',
      mainClonePath: '로컬 프로젝트',
      postCreateScript: '서버 사본',
    })
    // 사본이 하나도 없으면 기본값
    expect((await ctx.data.getEffective('octocat', 'dotfiles')).sources.worktreePath).toBe('서버 사본')
    ctx.state.serverCopy = {}
    expect((await ctx.data.getEffective('octocat', 'dotfiles')).sources.worktreePath).toBe('기본값')
    expect(ctx.api.putSettings).not.toHaveBeenCalled()
  })

  it('config set: 서버 규칙으로 검사하고, "-" 는 로컬 값을 지운다(전역 포함) — 빈 항목은 정리', async () => {
    const ctx = await createTestCtx({ mode: 'local' })
    await expect(configSet(ctx, 'branchTemplate', 'feat/x', {})).rejects.toThrow('branchTemplate 값이 올바르지 않습니다(invalid_template)')
    await expect(configSet(ctx, 'sparsePaths', '../x', { project: 'acme/widgets' })).rejects.toThrow('invalid_sparse_paths')
    await configSet(ctx, 'branchTemplate', 'feat/{number}', {})
    await configSet(ctx, 'sparsePaths', 'desktop', { project: 'Acme/Widgets' })
    expect((await readConfig(ctx.paths.config)).local).toMatchObject({ global: { branchTemplate: 'feat/{number}' }, projects: { 'acme/widgets': { sparsePaths: 'desktop' } } })
    await configSet(ctx, 'branchTemplate', '-', {})
    await configSet(ctx, 'sparsePaths', '-', { project: 'acme/widgets' })
    expect((await readConfig(ctx.paths.config)).local).toMatchObject({ global: {}, projects: {} })
    await configGet(ctx, {})
    expect(ctx.logs).toContain('[로컬 전역]')
    expect(ctx.logs).toContain('branchTemplate = (사본/기본값)')
    expect(ctx.api.getSettings).not.toHaveBeenCalled()
  })

  it('repos: 사본에서 시작해 로컬로 편집, reset 으로 사본 복귀 — 서버에는 쓰지 않는다', async () => {
    const ctx = await createTestCtx({ mode: 'local' })
    ctx.state.serverCopy = { visibleRepos: ['acme/widgets'], syncedAt: 't' }
    await reposAdd(ctx, ['octocat/*'])
    expect((await readConfig(ctx.paths.config)).local.visibleRepos).toEqual(['acme/widgets', 'octocat/*'])
    await reposList(ctx)
    expect(ctx.logs).toContain('[로컬 모드 · 로컬(이 기기)]')
    await reposReset(ctx)
    expect((await readConfig(ctx.paths.config)).local.visibleRepos).toBeUndefined()
    expect(ctx.logs.at(-1)).toBe('로컬 선택을 지웠습니다 — 서버 사본: acme/widgets')
    expect(ctx.api.putVisibleRepos).not.toHaveBeenCalled()
  })

  it('note 는 서버 모드에서만, doctor 는 서버 점검 없이 GitHub 인증을 필수로 본다', async () => {
    const ctx = await createTestCtx({ mode: 'local' })
    await expect(note(ctx, 'acme/widgets#7')).rejects.toThrow('메모는 서버 모드에서만')
    await expect(doctor(ctx)).rejects.toThrow('점검에 실패한 항목이 있습니다')
    expect(ctx.logs[0]).toContain('✓ 모드: 로컬 모드')
    expect(ctx.logs.join('\n')).toContain('✗ GitHub 인증 없음')
    expect(ctx.api.healthz).not.toHaveBeenCalled()
  })

  it('GitHub REST: 서버 토큰을 쓰지 않는다 — 환경 변수 토큰이 없으면 안내', async () => {
    const make = async (env: NodeJS.ProcessEnv) => {
      const base = await createTestCtx({ mode: 'local' })
      const api = createFakeApi()
      const fetch = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
      const ctx = await createContext({ env, paths: base.paths, api, host: createFakeHost() as unknown as NodeHost, fetch, out: { log: () => {}, error: () => {} } })
      return { ctx, api, fetch }
    }
    const none = await make({})
    await expect(none.ctx.github.listOwners()).rejects.toThrow(GITHUB_AUTH_REQUIRED)
    expect(none.api.getGithubToken).not.toHaveBeenCalled()
    const env = await make({ GITHUB_TOKEN: 'ghp_env' })
    await env.ctx.github.listOwners().catch(() => undefined)
    expect(env.fetch).toHaveBeenCalled()
    expect(new Headers((env.fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('authorization')).toContain('ghp_env')
  })
})

describe('서버 모드 — 받은 값을 사본으로 남긴다', () => {
  it('보일 저장소·전역 설정 조회와 설정 열기 때 사본을 갱신한다', async () => {
    const ctx = await createTestCtx({ api: { getSettings: async () => GLOBAL, getVisibleRepos: async () => ({ repos: ['acme/*'], updatedAt: 't' }) } })
    await ls(ctx, undefined, {})
    await configGet(ctx, {})
    await ctx.data.getEffective('Acme', 'Widgets')
    expect(ctx.state.serverCopy).toMatchObject({ visibleRepos: ['acme/*'], global: { worktreePath: '~/copy/{owner}/{repo}/{branch}' } })
    expect(ctx.state.effective['acme/widgets']).toEqual(EFFECTIVE)
    const saved = JSON.parse(await readFile(ctx.paths.state, 'utf8'))
    expect(saved.serverCopy.syncedAt).toEqual(expect.any(String))
  })

  it('repos reset 은 로컬 모드 전용', async () => {
    const ctx = await createTestCtx()
    await expect(reposReset(ctx)).rejects.toBeInstanceOf(CliError)
  })
})
