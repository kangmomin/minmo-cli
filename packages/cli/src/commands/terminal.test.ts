// 터미널 방식(shell ↔ tmux) — 설정 저장·명령·OS 별 터미널 열기
import type { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { openTerminal, terminalAvailable, terminalLabel } from '../host/terminal'
import { createTestCtx } from '../test/fakes'
import { terminalCmd } from './terminal'

const readConfig = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

describe('minmo terminal', () => {
  it('기본은 일반 셸 — 인자 없이 현재 값, 잘못된 값은 종료 코드 2', async () => {
    const ctx = await createTestCtx()
    expect(ctx.config.terminal).toBe('shell')
    await terminalCmd(ctx, undefined, 'linux')
    expect(ctx.logs[0]).toBe('현재: 셸(exit 로 돌아옴)')
    expect(ctx.logs[1]).toContain('minmo terminal tmux')
    await expect(terminalCmd(ctx, 'screen', 'linux')).rejects.toMatchObject({ exitCode: 2 })
  })

  it('tmux 로 바꾸면 config.json 에 저장하고 다음 실행에도 유지한다 — shell 로 되돌릴 수 있다', async () => {
    const ctx = await createTestCtx()
    await terminalCmd(ctx, 'tmux', 'linux')
    expect(ctx.config.terminal).toBe('tmux')
    expect((await readConfig(ctx.paths.config)).terminal).toBe('tmux')
    const next = await createTestCtx({ paths: ctx.paths })
    expect(next.config.terminal).toBe('tmux')
    await terminalCmd(next, undefined, 'linux')
    expect(next.logs[0]).toBe('현재: tmux')
    await terminalCmd(next, 'shell', 'linux')
    expect((await readConfig(ctx.paths.config)).terminal).toBe('shell')
  })

  it('Windows 는 tmux 를 고를 수 없다(항상 PowerShell)', async () => {
    const ctx = await createTestCtx()
    await expect(terminalCmd(ctx, 'tmux', 'win32')).rejects.toThrow('Windows 에서는 tmux 를 쓸 수 없습니다')
    expect(ctx.config.terminal).toBe('shell')
    await terminalCmd(ctx, undefined, 'win32')
    expect(ctx.logs[0]).toBe('현재: PowerShell(exit 로 돌아옴)')
  })
})

describe('터미널 열기(Linux·macOS)', () => {
  it('shell: tmux 없이 worktree 에서 $SHELL 을 연다 — MINMO_WORKTREE 를 남긴다', async () => {
    const calls: { cmd: string; args: readonly string[]; opts: Record<string, unknown> }[] = []
    const fake = ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts })
      return { status: 3 }
    }) as unknown as typeof spawnSync
    const code = await openTerminal('/ws/a/b/etc', 'b#etc', { mode: 'shell', platform: 'linux', env: { SHELL: '/bin/zsh', PATH: 'p' }, spawn: fake })
    expect(code).toBe(3)
    expect(calls).toEqual([{ cmd: '/bin/zsh', args: [], opts: { cwd: '/ws/a/b/etc', stdio: 'inherit', env: { SHELL: '/bin/zsh', PATH: 'p', MINMO_WORKTREE: '/ws/a/b/etc' } } }])
    // SHELL 이 없으면 sh, 방식을 주지 않으면 shell
    await openTerminal('/ws/x', 't', { platform: 'darwin', env: {}, spawn: fake })
    expect(calls.at(-1)?.cmd).toBe('/bin/sh')
  })

  it('셸을 실행하지 못하면 오류로 알린다', async () => {
    const fail = (() => ({ status: null, error: new Error('ENOENT') })) as unknown as typeof spawnSync
    await expect(openTerminal('/ws/x', 't', { platform: 'linux', env: { SHELL: '/no/shell' }, spawn: fail })).rejects.toThrow('터미널을 열 수 없습니다: ENOENT')
  })

  it('shell·Windows 는 tmux 가 없어도 쓸 수 있다 — 안내 문구도 방식에 맞춘다', async () => {
    expect(await terminalAvailable('shell', 'linux')).toBe(true)
    expect(await terminalAvailable('tmux', 'win32')).toBe(true)
    expect(terminalLabel('shell', 'darwin')).toBe('셸(exit 로 돌아옴)')
    expect(terminalLabel('tmux', 'linux')).toBe('tmux')
    expect(terminalLabel('tmux', 'win32')).toBe('PowerShell(exit 로 돌아옴)')
  })
})
