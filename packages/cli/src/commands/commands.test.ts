import { readFile } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '@minmo/api-client'
import { worktreeId } from '@minmo/core'

import { CliError, requireLogin } from '../context'
import { buildProgram } from '../program'
import { createTestCtx } from '../test/fakes'
import { login } from './account'
import { ls, note, removeWorktree } from './issues'
import { configSet, reposAdd, reposRemove } from './settings'

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
    const offline = await createTestCtx({ api: { me: async () => Promise.reject(new ApiError({ status: 0, code: 'network_error' })) } })
    await expect(requireLogin(offline)).rejects.toThrow('SSH 역터널')
  })
})

describe('ls — 보일 저장소 필터(데스크탑과 같은 규칙)', () => {
  it('선택한 저장소만, worktree 있는 숨긴 저장소는 (숨김)', async () => {
    const ctx = await createTestCtx({ api: { getVisibleRepos: async () => ({ repos: ['acme/widgets'], updatedAt: 't' }) } })
    ctx.state.worktrees[worktreeId('octocat', 'dotfiles', '1')] = { path: '/w/1', branch: 'b' }
    await ls(ctx, undefined, {})
    expect(ctx.logs).toEqual(['octocat/dotfiles  ●1  (숨김)', 'Acme/Widgets'])
  })

  it('owner/repo → ★기타 + open + closed 중 worktree 있는 것, --json', async () => {
    const ctx = await createTestCtx()
    ctx.state.worktrees[worktreeId('Acme', 'Widgets', '3')] = { path: '/w/3', branch: 'b3' }
    await ls(ctx, 'acme/widgets', { json: true })
    const rows = JSON.parse(ctx.logs[0])
    expect(rows.map((r: { key: string }) => r.key)).toEqual(['etc', '7', '3'])
    expect(rows[2]).toMatchObject({ state: 'closed', worktree: '/w/3', owner: 'Acme', repo: 'Widgets' })
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
})

describe('config set — 현재 레코드에서 그 키만 바꿔 보낸다', () => {
  it('프로젝트 설정 postCreateScriptPosix, "-" 는 상속(null)', async () => {
    const ctx = await createTestCtx({ api: { getSettings: async () => ({ ...(await import('../test/fakes')).EMPTY_RECORD, sparsePaths: 'desktop' }) } })
    await configSet(ctx, 'postCreateScriptPosix', 'npm ci', { project: 'Acme/Widgets' })
    expect(ctx.api.putSettings).toHaveBeenLastCalledWith({ kind: 'project', owner: 'Acme', repo: 'Widgets' }, expect.objectContaining({ postCreateScriptPosix: 'npm ci', sparsePaths: 'desktop' }))
    await configSet(ctx, 'sparsePaths', '-', { project: 'Acme/Widgets' })
    expect(ctx.api.putSettings.mock.lastCall?.[1].sparsePaths).toBeNull()
    await expect(configSet(ctx, 'worktreePath', '-', {})).rejects.toThrow('전역 설정은 상속')
    await expect(configSet(ctx, 'nope', 'x', {})).rejects.toThrow('알 수 없는 설정')
  })
})

describe('rm·note', () => {
  it('rm: 미커밋이 있으면 묻고, 거절하면 지우지 않는다', async () => {
    const ctx = await createTestCtx()
    const t = { owner: 'Acme', repo: 'Widgets', key: '7', number: 7, title: 'Seven' }
    ctx.state.worktrees[worktreeId('Acme', 'Widgets', '7')] = { path: '/w/7', branch: 'b' }
    ctx.worktree.deleteWorktree = vi.fn(async (_t, o) => (o?.confirmed ? { status: 'deleted' as const } : { status: 'needs_confirmation' as const, uncommitted: 2, unpushed: 0 }))
    const ask = vi.fn(async () => false)
    await expect(removeWorktree(ctx, t, { ask })).rejects.toThrow('취소')
    expect(ask).toHaveBeenCalledWith(expect.stringContaining('미커밋 변경 2개'))
    ask.mockResolvedValueOnce(true)
    await removeWorktree(ctx, t, { ask })
    expect(ctx.worktree.deleteWorktree).toHaveBeenLastCalledWith(t, { confirmed: true })
    await expect(removeWorktree(ctx, { ...t, key: 'etc', number: null }, {})).rejects.toThrow('★기타')
  })

  it('note: 다른 기기가 먼저 저장(409)하면 내 내용을 파일로 남긴다', async () => {
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
})

describe('명령어 구성', () => {
  it('인자·옵션이 각 명령으로 간다', async () => {
    const ctx = await createTestCtx()
    const runTui = vi.fn(async () => {})
    const program = buildProgram({ createCtx: async () => ctx, runTui, version: '0.0.0' }).exitOverride()
    await program.parseAsync(['node', 'minmo', 'repos', 'add', 'a/b'])
    expect(ctx.api.putVisibleRepos).toHaveBeenLastCalledWith({ repos: ['a/b'], baseUpdatedAt: null })
    await program.parseAsync(['node', 'minmo'])
    expect(runTui).toHaveBeenCalledTimes(1)
    await expect(program.parseAsync(['node', 'minmo', 'open', 'not-a-ref', '--no-attach'])).rejects.toThrow('owner/repo#번호')
  })
})
