import { readFile } from 'node:fs/promises'

import type { CommanderError } from 'commander'
import { describe, expect, it } from 'vitest'

import { ApiError } from '@minmo/api-client'
import type { SettingsRecord } from '@minmo/api-client'

import { CliError, requireLogin } from '../context'
import { buildProgram } from '../program'
import { createTestCtx, EMPTY_RECORD } from '../test/fakes'
import { doctor, login } from './account'
import { note } from './note'
import { configGet, configSet, reposAdd, reposList, reposRemove } from './settings'

const offline = () => Promise.reject(new ApiError({ status: 0, code: 'network_error' }))

describe('로그인·계정 확인', () => {
  it('login: 코드 교환(label=호스트명) → /me 로 계정 확인 → 0600 자격 증명 저장', async () => {
    const ctx = await createTestCtx({ loggedIn: false })
    await login(ctx, 'abcd-efgh')
    expect(ctx.api.exchangeCliCode).toHaveBeenCalledWith('abcd-efgh', expect.any(String))
    expect(ctx.api.me).toHaveBeenCalledWith({ token: 'sess_cli' })
    const saved = JSON.parse(await readFile(ctx.paths.credentials, 'utf8'))
    expect(saved).toMatchObject({ session: 'sess_cli', login: 'octocat' })
    expect(ctx.logs.at(-1)).toContain('로그인했습니다: octocat')
  })

  it('login: 잘못된 코드는 안내', async () => {
    const ctx = await createTestCtx({
      loggedIn: false,
      api: {
        exchangeCliCode: async () => {
          throw new ApiError({ status: 400, code: 'invalid_cli_code' })
        },
      },
    })
    await expect(login(ctx, 'x')).rejects.toThrow('코드가 맞지 않거나 만료')
  })

  it('requireLogin: 연결된 서버 계정이 다르면 막는다(다른 터널로 토큰 유출 방지)', async () => {
    const ctx = await createTestCtx({ api: { me: async () => ({ id: 'u2', githubLogin: 'mallory', avatarUrl: null }) } })
    await expect(requireLogin(ctx)).rejects.toThrow('계정(mallory)이 로그인한 계정(octocat)과 다릅니다')
  })

  it('requireLogin: 로그인 안 됨·세션 폐기(401)·터널 끊김(offline) 안내', async () => {
    await expect(requireLogin(await createTestCtx({ loggedIn: false }))).rejects.toThrow('minmo login')
    const revoked = await createTestCtx({ api: { me: async () => Promise.reject(new ApiError({ status: 401, code: 'unauthorized' })) } })
    await expect(requireLogin(revoked)).rejects.toThrow('세션이 만료되었거나 끊겼습니다')
    const disconnected = await createTestCtx({ api: { me: offline } })
    await expect(requireLogin(disconnected)).rejects.toThrow('SSH 역터널')
  })
})

describe('doctor — 서버 연결만 점검', () => {
  it('소켓·서버 응답·로그인을 보고, 하나라도 실패하면 종료 코드 1', async () => {
    const ctx = await createTestCtx()
    const err = (await doctor(ctx).catch((e: unknown) => e)) as CliError
    expect(err).toBeInstanceOf(CliError)
    expect(err.exitCode).toBe(1)
    // 테스트의 소켓 경로는 없다 — 서버 응답·로그인은 가짜 API 로 통과
    expect(ctx.logs).toEqual([`✗ 역터널 소켓 없음: ${ctx.paths.socket}`, expect.stringContaining('→ PC 의 ~/.ssh/config'), '✓ 서버 응답', '✓ 로그인: octocat'])
  })

  it('서버에 닿지 않으면 로그인은 확인하지 않는다', async () => {
    const ctx = await createTestCtx({ api: { healthz: offline } })
    await expect(doctor(ctx)).rejects.toBeInstanceOf(CliError)
    expect(ctx.logs).toContain('✗ 서버에 연결할 수 없음')
    expect(ctx.api.me).not.toHaveBeenCalled()
  })
})

describe('repos — 읽고 바꿔 baseUpdatedAt 으로 저장, 409 면 한 번 재시도', () => {
  it('add: 전체 표시(null) 에서 시작해 추가, 조직 전체(owner/*)', async () => {
    const ctx = await createTestCtx()
    await reposAdd(ctx, ['Acme/Widgets', 'zed/*'])
    expect(ctx.api.putVisibleRepos).toHaveBeenLastCalledWith({ repos: ['acme/widgets', 'zed/*'], baseUpdatedAt: null })
  })

  it('충돌(409) 이면 최신 값을 다시 읽어 한 번 더 시도', async () => {
    let calls = 0
    const ctx = await createTestCtx({
      api: {
        getVisibleRepos: async () => ({ repos: calls === 0 ? ['a/x'] : ['a/x', 'b/y'], updatedAt: `t${calls}` }),
        putVisibleRepos: async (input) => {
          if (calls++ === 0) throw new ApiError({ status: 409, code: 'conflict' })
          return { repos: input.repos, updatedAt: 't9' }
        },
      },
    })
    await reposAdd(ctx, ['c/z'])
    expect(ctx.api.putVisibleRepos).toHaveBeenLastCalledWith({ repos: ['a/x', 'b/y', 'c/z'], baseUpdatedAt: 't1' })
  })

  it('rm: 전체 표시 상태에서는 먼저 고르라고 안내', async () => {
    const ctx = await createTestCtx()
    await expect(reposRemove(ctx, ['a/b'])).rejects.toThrow('먼저 `minmo repos add`')
  })

  it('list: 서버에 닿지 않으면 "전체 표시" 대신 오류', async () => {
    const ctx = await createTestCtx({ api: { getVisibleRepos: offline } })
    await expect(reposList(ctx)).rejects.toThrow('minmo 서버에 연결할 수 없습니다')
  })
})

describe('config', () => {
  const GLOBAL: SettingsRecord = { ...EMPTY_RECORD, worktreePath: '~/ws/{owner}/{repo}/{branch}', updatedAt: 't' }

  it('set: 현재 레코드에서 그 키만 바꿔 보낸다 — 프로젝트 설정 postCreateScriptPosix, "-" 는 상속(null)', async () => {
    const ctx = await createTestCtx({ api: { getSettings: async () => ({ ...EMPTY_RECORD, sparsePaths: 'desktop' }) } })
    await configSet(ctx, 'postCreateScriptPosix', 'npm ci', { project: 'Acme/Widgets' })
    expect(ctx.api.putSettings).toHaveBeenLastCalledWith({ kind: 'project', owner: 'Acme', repo: 'Widgets' }, expect.objectContaining({ postCreateScriptPosix: 'npm ci', sparsePaths: 'desktop' }))
    await configSet(ctx, 'sparsePaths', '-', { project: 'Acme/Widgets' })
    expect(ctx.api.putSettings.mock.lastCall?.[1].sparsePaths).toBeNull()
    await expect(configSet(ctx, 'worktreePath', '-', {})).rejects.toThrow('전역 설정은 상속')
    await expect(configSet(ctx, 'nope', 'x', {})).rejects.toThrow('알 수 없는 설정')
  })

  it('get: JSON 출력은 이전과 같다(updatedAt, sources 코드)', async () => {
    const ctx = await createTestCtx({ api: { getSettings: async () => GLOBAL } })
    await configGet(ctx, { json: true })
    expect(JSON.parse(ctx.logs[0])).toMatchObject({ updatedAt: 't', worktreePath: '~/ws/{owner}/{repo}/{branch}' })
    await configGet(ctx, { effective: 'acme/widgets', json: true })
    expect(JSON.parse(ctx.logs[1]).sources.branchTemplate).toBe('global')
  })

  it('get --effective: 서버에 닿지 않으면 오류(사본으로 대신하지 않는다)', async () => {
    const ctx = await createTestCtx({ api: { getEffective: offline } })
    await expect(configGet(ctx, { effective: 'acme/widgets' })).rejects.toThrow('minmo 서버에 연결할 수 없습니다')
  })
})

describe('note', () => {
  it('다른 기기가 먼저 저장(409)하면 내 내용을 파일로 남긴다', async () => {
    const ctx = await createTestCtx({
      api: {
        getNotes: async () => ({ body: 'old', updatedAt: 't1' }),
        putNotes: async () => {
          throw new ApiError({ status: 409, code: 'conflict' })
        },
      },
    })
    const err = (await note(ctx, 'Acme/Widgets#7', { edit: async () => 'mine' }).catch((e: unknown) => e)) as CliError
    expect(err).toBeInstanceOf(CliError)
    const path = /\s(\S+note-conflict\S+\.md)/.exec(err.message)![1]
    expect(await readFile(path, 'utf8')).toBe('mine')
    expect(ctx.api.putNotes).toHaveBeenCalledWith('Acme', 'Widgets', '7', { body: 'mine', baseUpdatedAt: 't1' })
  })

  it('편집기가 CRLF 로 저장해도 바꾸지 않았으면 올리지 않고, 바꿨으면 LF 로 올린다', async () => {
    const ctx = await createTestCtx({ api: { getNotes: async () => ({ body: 'a\nb', updatedAt: 't1' }) } })
    await note(ctx, 'Acme/Widgets#7', { edit: async () => 'a\r\nb' })
    expect(ctx.logs.at(-1)).toBe('변경 없음')
    expect(ctx.api.putNotes).not.toHaveBeenCalled()
    await note(ctx, 'Acme/Widgets#7', { edit: async () => 'a\r\nc' })
    expect(ctx.api.putNotes).toHaveBeenCalledWith('Acme', 'Widgets', '7', { body: 'a\nc', baseUpdatedAt: 't1' })
  })
})

describe('명령어 구성', () => {
  const run = async (argv: string[]) => {
    const ctx = await createTestCtx()
    const program = buildProgram({ createCtx: async () => ctx, version: '0.0.0' })
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    const err = (await program.parseAsync(['node', 'minmo', ...argv]).then(() => null, (e: unknown) => e)) as CommanderError | null
    return { ctx, err }
  }

  it('인자·옵션이 각 명령으로 간다', async () => {
    const { ctx, err } = await run(['repos', 'add', 'a/b'])
    expect(err).toBeNull()
    expect(ctx.api.putVisibleRepos).toHaveBeenLastCalledWith({ repos: ['a/b'], baseUpdatedAt: null })
  })

  it('인자 없이 실행하면 도움말, 삭제된 명령(TUI·worktree)은 unknown command', async () => {
    expect((await run([])).err?.code).toBe('commander.help')
    for (const cmd of ['open', 'ls', 'rm', 'new', 'mode', 'terminal', 'base-dir', 'base-repo']) {
      expect((await run([cmd, 'x'])).err?.code).toBe('commander.unknownCommand')
    }
  })
})
