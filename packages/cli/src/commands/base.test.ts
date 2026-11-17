// 이 기기에만 두는 경로 — 기본 폴더(base-dir)·저장소별 원본 위치(base-repo): 저장·검사·worktree 준비에 반영
import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import type { Effective } from '@minmo/api-client'
import { DEFAULT_SETTINGS } from '@minmo/core'
import { fail, ok } from '@minmo/core/testing'

import { buildProgram } from '../program'
import { EFFECTIVE, createTestCtx } from '../test/fakes'
import { doctor } from './account'
import { baseDirCmd, baseRepoCmd } from './base'
import { openIssue } from './issues'

const readConfig = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
// 테스트는 실제 OS 의 경로 규칙으로 돈다
const WIN = process.platform === 'win32'
const ABS = WIN ? 'D:\\ws' : '/ws'
const REPO = WIN ? 'D:\\src\\widgets' : '/src/widgets'
const sep = WIN ? '\\' : '/'
/** 기본 뿌리(~/minmo-workspaces)를 쓰는 설정 — 기본 폴더가 적용되는 경우 */
const DEFAULT_EFF: Effective = { ...EFFECTIVE, values: { ...EFFECTIVE.values, worktreePath: DEFAULT_SETTINGS.worktreePath, mainClonePath: DEFAULT_SETTINGS.mainClonePath } }
/** 준비 과정에서 부른 git 명령(인자 목록) */
const gitCalls = (ctx: Awaited<ReturnType<typeof createTestCtx>>) => (ctx.host.gitRun as unknown as { mock: { calls: [string[]][] } }).mock.calls.map(([a]) => a)

describe('minmo base-dir', () => {
  it('인자 없이 현재 값 · 저장하면 config.json 에 남고 다음 실행에도 유지 · - 로 해제', async () => {
    const ctx = await createTestCtx()
    await baseDirCmd(ctx)
    expect(ctx.logs[0]).toBe('현재: 없음 — 경로 설정 그대로(~/minmo-workspaces)')
    await baseDirCmd(ctx, ` ${ABS} `)
    expect(ctx.config.baseDir).toBe(ABS)
    expect((await readConfig(ctx.paths.config)).baseDir).toBe(ABS)
    const next = await createTestCtx({ paths: ctx.paths })
    await baseDirCmd(next)
    expect(next.logs[0]).toBe(`현재: ${ABS}`)
    await doctor(next).catch(() => undefined)
    expect(next.logs).toContain(`✓ 기본 폴더: ${ABS}`)
    await baseDirCmd(next, '-')
    expect(next.config.baseDir).toBeUndefined()
    expect(await readConfig(ctx.paths.config)).not.toHaveProperty('baseDir')
  })

  it('상대 경로·템플릿 기호는 받지 않는다(종료 코드 2) · ~ 로 시작하는 경로는 받는다', async () => {
    const ctx = await createTestCtx()
    for (const bad of ['ws', '', `${ABS}${sep}{owner}`]) await expect(baseDirCmd(ctx, bad)).rejects.toMatchObject({ exitCode: 2 })
    expect(ctx.config.baseDir).toBeUndefined()
    await baseDirCmd(ctx, '~/ws')
    expect(ctx.config.baseDir).toBe('~/ws')
  })

  it('기본 폴더가 있으면 메인 clone 과 worktree 를 그 아래에 만든다 — 뿌리를 바꾼 경로 설정에는 쓰지 않는다', async () => {
    const ctx = await createTestCtx({ api: { getEffective: async () => DEFAULT_EFF } })
    await baseDirCmd(ctx, ABS)
    // 가짜 호스트라 준비 도중 실패해도 된다 — clone 위치만 본다
    await openIssue(ctx, 'acme/widgets#7', { attach: false }).catch(() => undefined)
    expect(gitCalls(ctx).find((a) => a.includes('clone'))?.at(-1)).toBe(`${ABS}${sep}Acme${sep}Widgets${sep}_main`)

    const custom = await createTestCtx()
    await baseDirCmd(custom, ABS)
    await openIssue(custom, 'acme/widgets#7', { attach: false }).catch(() => undefined)
    expect(gitCalls(custom).find((a) => a.includes('clone'))?.at(-1)).toBe(`${custom.home}${sep}ws${sep}Acme${sep}Widgets${sep}_main`)
  })

  it('명령으로 실행: `minmo base-dir <경로>`', async () => {
    const ctx = await createTestCtx()
    await buildProgram({ createCtx: async () => ctx, runTui: async () => undefined, version: '0.0.0' }).parseAsync(['node', 'minmo', 'base-dir', ABS])
    expect(ctx.config.baseDir).toBe(ABS)
  })
})

describe('minmo base-repo', () => {
  /** REPO 는 작업 폴더가 있는 저장소의 최상위다 */
  const repoHost = (origin = ok('git@github.com:Acme/Widgets.git\n')) => ({
    gitRun: async (args: string[]) => {
      if (args.includes('--show-toplevel')) return args[1] === REPO ? ok(`${REPO}\n${REPO}/.git\n`) : fail('fatal: not a git repository', 128)
      if (args.includes('get-url')) return origin
      return ok('')
    },
  })

  it('저장소 폴더를 확인하고 저장한다(키는 소문자) · 목록·현재 값 보기 · - 로 해제', async () => {
    const ctx = await createTestCtx({ host: repoHost() })
    await baseRepoCmd(ctx, undefined)
    expect(ctx.logs[0]).toContain('원본 위치를 정한 저장소가 없습니다')
    await baseRepoCmd(ctx, 'Acme/Widgets', `${REPO}${sep}`)
    expect(ctx.config.baseRepos).toEqual({ 'acme/widgets': REPO })
    expect((await readConfig(ctx.paths.config)).baseRepos).toEqual({ 'acme/widgets': REPO })
    expect(ctx.logs.at(-1)).toContain(`Acme/Widgets 의 원본 위치: ${REPO}`)
    const next = await createTestCtx({ paths: ctx.paths, host: repoHost() })
    await baseRepoCmd(next, 'acme/widgets')
    expect(next.logs[0]).toBe(`현재: ${REPO}`)
    await baseRepoCmd(next, undefined)
    expect(next.logs[1]).toBe(`acme/widgets\t${REPO}`)
    await baseRepoCmd(next, 'ACME/widgets', '-')
    expect(next.config.baseRepos).toEqual({})
    expect((await readConfig(ctx.paths.config)).baseRepos).toEqual({})
  })

  it('git 저장소가 아니면 저장하지 않는다(종료 코드 2) · origin 이 다르면 저장하고 알린다', async () => {
    const ctx = await createTestCtx({ host: repoHost(ok('https://github.com/other/fork.git\n')) })
    await expect(baseRepoCmd(ctx, 'acme/widgets', `${ABS}${sep}nope`)).rejects.toMatchObject({ exitCode: 2 })
    expect(ctx.config.baseRepos).toBeUndefined()
    await baseRepoCmd(ctx, 'acme/widgets', REPO)
    expect(ctx.config.baseRepos).toEqual({ 'acme/widgets': REPO })
    expect(ctx.logs.at(-1)).toContain('origin 이 다른 저장소입니다')
  })

  it('원본 위치가 있으면 clone 하지 않고 그 저장소에서 준비한다 · 폴더가 없어졌으면 알린다', async () => {
    const ctx = await createTestCtx({ host: { ...repoHost(), pathExists: async (p: string) => p === REPO } })
    await baseRepoCmd(ctx, 'acme/widgets', REPO)
    await openIssue(ctx, 'acme/widgets#7', { attach: false }).catch(() => undefined)
    const calls = gitCalls(ctx)
    expect(calls.some((a) => a.includes('clone'))).toBe(false)
    expect(calls.some((a) => a[0] === '-C' && a[1] === REPO && a.includes('fetch'))).toBe(true)

    const gone = await createTestCtx({ paths: ctx.paths })
    await expect(openIssue(gone, 'acme/widgets#7', { attach: false })).rejects.toThrow('원본 위치 폴더가 없습니다')
    expect(gitCalls(gone).some((a) => a.includes('clone'))).toBe(false)
  })
})
