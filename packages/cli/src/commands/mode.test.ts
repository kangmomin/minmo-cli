// 서버 모드 / 로컬 모드 — 전환·서버 사본·로컬 값 우선순위·모드별 명령 동작
import { readFile, writeFile } from 'node:fs/promises'

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
  it('local: 서버에 닿으면 사본(전역·보일 저장소·조직·worktree/고른 저장소 설정)을 받고 전환한다', async () => {
    const ctx = await createTestCtx({
      api: {
        getSettings: async (scope) => (scope.kind === 'org' ? { ...EMPTY_RECORD, branchTemplate: `${scope.owner}/{number}` } : GLOBAL),
        getVisibleRepos: async () => ({ repos: ['acme/widgets', 'octocat/*'], updatedAt: 't' }),
      },
      github: { listOwners: async () => [{ login: 'Initech', kind: 'org', avatarUrl: null }] },
    })
    ctx.state.worktrees[worktreeId('octocat', 'dotfiles', '1')] = { path: '/w/1', branch: 'b' }
    await modeCmd(ctx, 'local')
    expect(ctx.api.getEffective.mock.calls.map((c) => c.join('/')).sort()).toEqual(['acme/widgets', 'octocat/dotfiles'])
    const state = JSON.parse(await readFile(ctx.paths.state, 'utf8'))
    expect(state.serverCopy).toMatchObject({ global: { worktreePath: '~/copy/{owner}/{repo}/{branch}' }, visibleRepos: ['acme/widgets', 'octocat/*'], syncedAt: expect.any(String) })
    // owner/* 만 고른 조직·GitHub 에서 보이는 조직의 설정도 받는다(값이 있는 필드만)
    expect(state.serverCopy.orgs).toEqual({ acme: { branchTemplate: 'acme/{number}' }, octocat: { branchTemplate: 'octocat/{number}' }, initech: { branchTemplate: 'initech/{number}' } })
    expect(Object.keys(state.effective).sort()).toEqual(['acme/widgets', 'octocat/dotfiles'])
    expect((await readConfig(ctx.paths.config)).mode).toBe('local')
    expect(ctx.logs.join('\n')).toContain('서버 사본을 갱신했습니다 — 전역 설정·보일 저장소·조직 설정 3개·저장소 설정 2개')
    // 로컬 모드에서 사본에 없는 저장소도 조직 사본을 쓴다
    const local = await createTestCtx({ paths: ctx.paths, loggedIn: false })
    expect((await local.data.getEffective('Initech', 'new')).values.branchTemplate).toBe('initech/{number}')
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
      worktreePath: 'copy',
      sparsePaths: 'copy',
      etcBranchName: 'local-global',
      postCreateScriptPosix: 'local-org',
      mainClonePath: 'local-project',
      postCreateScript: 'copy',
    })
    // 사본이 하나도 없으면 기본값
    expect((await ctx.data.getEffective('octocat', 'dotfiles')).sources.worktreePath).toBe('copy')
    ctx.state.serverCopy = {}
    expect((await ctx.data.getEffective('octocat', 'dotfiles')).sources.worktreePath).toBe('default')
    expect(ctx.api.putSettings).not.toHaveBeenCalled()
  })

  it('effective: 조직 사본이 있으면 저장소 사본에 섞인(더 오래된) 조직 값은 쓰지 않는다', async () => {
    const ctx = await createTestCtx({ mode: 'local' })
    ctx.state.serverCopy = { orgs: { acme: { etcBranchName: 'new-etc' } } }
    ctx.state.effective['acme/widgets'] = {
      values: { ...EFFECTIVE.values, etcBranchName: 'old-etc', postCreateScript: 'old-org-script', sparsePaths: 'desktop' },
      sources: { ...EFFECTIVE.sources, etcBranchName: 'org', postCreateScript: 'org', sparsePaths: 'project' },
    }
    const eff = await ctx.data.getEffective('Acme', 'Widgets')
    // 조직 사본에서 없어진 조직 값(postCreateScript)은 되살리지 않고, 프로젝트 값은 그대로
    expect(eff.values).toMatchObject({ etcBranchName: 'new-etc', postCreateScript: '', sparsePaths: 'desktop' })
    // 전역 사본이 없으면 저장소 사본의 전역 값이라도 쓴다(기본값보다 서버에 가깝다)
    expect(eff.values.worktreePath).toBe(EFFECTIVE.values.worktreePath)
  })

  it('config: 조직 이름이 객체 키여도 안전 — constructor·__proto__, 서버가 받지 않을 이름은 거부', async () => {
    const ctx = await createTestCtx({ mode: 'local' })
    await configSet(ctx, 'branchTemplate', 'x/{number}', { org: 'constructor' })
    expect((await ctx.data.getEffective('constructor', 'r')).values.branchTemplate).toBe('x/{number}')
    await configSet(ctx, 'branchTemplate', 'p/{number}', { org: '__proto__' })
    expect(({} as Record<string, unknown>).branchTemplate).toBeUndefined()
    expect((await ctx.data.getEffective('__proto__', 'r')).values.branchTemplate).toBe('p/{number}')
    const disk = await readConfig(ctx.paths.config)
    expect(Object.keys(disk.local.orgs).sort()).toEqual(['__proto__', 'constructor'])
    await expect(configSet(ctx, 'branchTemplate', 'x/{number}', { org: 'foo bar' })).rejects.toThrow('조직·저장소 이름이 올바르지 않습니다')
  })

  it('repos: 다른 SSH 세션이 그 사이 바꾼 선택을 덮어쓰지 않는다(파일의 최신 값 위에서 바꾼다)', async () => {
    const ctx = await createTestCtx({ mode: 'local' })
    await reposAdd(ctx, ['acme/widgets'])
    // 다른 세션의 `minmo repos add acme/x`
    const other = await createTestCtx({ paths: ctx.paths, loggedIn: false })
    await reposAdd(other, ['acme/x'])
    await reposAdd(ctx, ['octocat/*'])
    expect((await readConfig(ctx.paths.config)).local.visibleRepos).toEqual(['acme/widgets', 'acme/x', 'octocat/*'])
    expect(ctx.config.local.visibleRepos).toEqual(['acme/widgets', 'acme/x', 'octocat/*'])
  })

  it('config.json 이 깨졌으면 고칠 곳을 알려 준다(스택 없이)', async () => {
    const ctx = await createTestCtx({ mode: 'local' })
    await writeFile(ctx.paths.config, '{ broken')
    await expect(createTestCtx({ paths: ctx.paths })).rejects.toThrow(/설정 파일을 읽을 수 없습니다: .*config\.json/)
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
    // 일부만 받은 사본 — 전체 갱신 시각은 `mode local` 때만 남긴다
    const saved = JSON.parse(await readFile(ctx.paths.state, 'utf8'))
    expect(saved.serverCopy.syncedAt).toBeUndefined()
  })

  it('config set: 저장된 값으로 사본을 갱신한다(전역·조직), 프로젝트는 그 저장소 설정을 다시 받는다', async () => {
    const ctx = await createTestCtx({ api: { getSettings: async () => GLOBAL } })
    await configSet(ctx, 'branchTemplate', 'feat/{number}', {})
    expect(ctx.state.serverCopy.global?.branchTemplate).toBe('feat/{number}')
    await configSet(ctx, 'etcBranchName', 'misc', { org: 'Acme' })
    expect(ctx.state.serverCopy.orgs?.acme).toMatchObject({ etcBranchName: 'misc' })
    await configSet(ctx, 'sparsePaths', 'desktop', { project: 'Acme/Widgets' })
    expect(ctx.api.getEffective).toHaveBeenCalledWith('Acme', 'Widgets')
    expect(ctx.state.effective['acme/widgets']).toEqual(EFFECTIVE)
  })

  it('JSON 출력은 이전과 같다(updatedAt, sources 코드) — 오프라인이면 사본을 보여 주며 stderr 로 알린다', async () => {
    const ctx = await createTestCtx({ api: { getSettings: async () => GLOBAL } })
    await configGet(ctx, { json: true })
    expect(JSON.parse(ctx.logs[0])).toMatchObject({ updatedAt: 't', worktreePath: '~/copy/{owner}/{repo}/{branch}' })
    await configGet(ctx, { effective: 'acme/widgets', json: true })
    expect(JSON.parse(ctx.logs[1]).sources.branchTemplate).toBe('global')
    ctx.api.getEffective.mockImplementation(offline)
    await configGet(ctx, { effective: 'acme/widgets' })
    expect(ctx.errors).toEqual(['서버에 연결할 수 없어 마지막으로 받은 사본을 보여 줍니다'])
    expect(ctx.logs.at(-1)).toContain('(서버 사본)')
  })

  it('repos list: 서버에 닿지 않으면 "전체 표시" 대신 오류', async () => {
    const ctx = await createTestCtx({ api: { getVisibleRepos: offline } })
    await expect(reposList(ctx)).rejects.toThrow('minmo 서버에 연결할 수 없습니다')
  })

  it('repos reset 은 로컬 모드 전용', async () => {
    const ctx = await createTestCtx()
    await expect(reposReset(ctx)).rejects.toBeInstanceOf(CliError)
  })
})
