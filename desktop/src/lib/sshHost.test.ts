// 원격 호스트 구현 — 명령 구성·안전 조건·tmux 세션 이름·오류 안내
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { createFakeTauri, fail, ok } from '../test/fakes'
import { assertRelative, assertRemovable, createSshOps, remotePty, sha1Hex, sshErrorOf, sshErrorText, tmuxSessionName } from './sshHost'
import type { SshProbe } from './tauri'

const PROBE: SshProbe = { platform: 'linux', home: '/home/dev', git: 'git version 2.43.0', tmux: true }

function setup(probe: SshProbe = PROBE, overrides: Parameters<typeof createFakeTauri>[0] = {}) {
  const { tauri } = createFakeTauri(overrides)
  return { tauri, ops: createSshOps(tauri, 'my-server', probe) }
}

describe('sha1Hex · tmuxSessionName', () => {
  it('알려진 값과 같다(빈 문자열·abc·블록 경계·한글)', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    for (const text of ['a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(200), '/home/dev/작업/이슈-1']) {
      expect(sha1Hex(text)).toBe(createHash('sha1').update(text).digest('hex'))
    }
  })

  it('원격 CLI 와 같은 세션 이름 — 끝의 / 는 무시한다', () => {
    const path = '/home/dev/minmo-workspaces/acme/app/feat-1'
    const expected = `minmo-${createHash('sha1').update(path).digest('hex').slice(0, 10)}`
    expect(tmuxSessionName(path)).toBe(expected)
    expect(tmuxSessionName(`${path}/`)).toBe(expected)
  })
})

describe('remotePty', () => {
  it('tmux 가 있으면 첫 패널은 기본 세션, 분할 패널은 떼면 사라지는 세션', () => {
    const name = tmuxSessionName('/w/t')
    expect(remotePty('h', true, '/w/t', { primary: true, seq: 1 })).toEqual({ host: 'h', session: name, ephemeral: false })
    expect(remotePty('h', true, '/w/t', { primary: false, seq: 3 })).toEqual({ host: 'h', session: `${name}-p3`, ephemeral: true })
  })

  it('tmux 가 없으면 로그인 셸', () => {
    expect(remotePty('h', false, '/w/t', { primary: true, seq: 1 })).toEqual({ host: 'h', session: null, ephemeral: false })
  })
})

describe('안전 조건', () => {
  it('얕은 경로·홈·상대 경로·.. 는 지우지 않는다', () => {
    for (const p of ['/', '/home', '/home/dev', '/home/dev/', 'home/dev/a/b', '/home/dev/a/../../x', '/a/b']) {
      expect(() => assertRemovable(p, '/home/dev')).toThrow('지울 수 없는 경로')
    }
    expect(() => assertRemovable('/home/dev/minmo-workspaces/acme/app/feat-1', '/home/dev')).not.toThrow()
  })

  it('보관 파일 경로는 폴더 안의 상대 경로만', () => {
    for (const rel of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a\\b', 'a\nb']) expect(() => assertRelative(rel)).toThrow()
    for (const rel of ['.env', 'config/local.json']) expect(() => assertRelative(rel)).not.toThrow()
  })
})

describe('createSshOps', () => {
  it('git 은 원격에서 프롬프트 없이 실행한다', async () => {
    const { tauri, ops } = setup()
    await ops.gitRun(['-C', '/w/t', 'status'], { env: { A: '1' } })
    expect(tauri.sshExec).toHaveBeenCalledWith('my-server', ['git', '-C', '/w/t', 'status'], { cwd: undefined, env: { GIT_TERMINAL_PROMPT: '0', A: '1' } })
  })

  it('pathExists 는 test -e 의 종료 코드로 판단한다', async () => {
    const { ops } = setup(PROBE, { sshExec: async (_h, argv) => (argv[2] === '/yes' ? ok() : fail('', 1)) })
    expect(await ops.pathExists('/yes')).toBe(true)
    expect(await ops.pathExists('/no')).toBe(false)
  })

  it('removeDir 는 안전 조건을 통과한 경로만 rm -rf 한다', async () => {
    const { tauri, ops } = setup()
    await expect(ops.removeDir('/home/dev')).rejects.toThrow('지울 수 없는 경로')
    expect(tauri.sshExec).not.toHaveBeenCalled()
    await ops.removeDir('/home/dev/ws/acme/app')
    expect(tauri.sshExec).toHaveBeenCalledWith('my-server', ['rm', '-rf', '--', '/home/dev/ws/acme/app'], undefined)
  })

  it('파일 목록·복사 개수는 스크립트 출력에서 읽고, 경로는 인자로 넘긴다', async () => {
    const { tauri, ops } = setup(PROBE, {
      sshExec: async (_h, argv) => (argv.length === 4 ? ok('.env\nconfig/local.json\n') : ok('2\n')),
    })
    expect(await ops.listFiles('/keep')).toEqual(['.env', 'config/local.json'])
    expect(await ops.copyTree('/keep', '/w/t')).toBe(2)
    const [, argv, opts] = tauri.sshExec.mock.calls[1]
    expect(argv).toEqual(['sh', '-s', '--', '/keep', '/w/t'])
    // 경로가 스크립트 본문에 섞이지 않는다(따옴표·공백이 있어도 안전)
    expect(opts?.stdin).not.toContain('/keep')
  })

  it('보관 실패는 원격 stderr 를 오류로 돌려준다', async () => {
    const { ops } = setup(PROBE, { sshExec: async () => fail('파일이 없습니다: .env') })
    await expect(ops.copyFileInto('/w/t', '.env', '/keep')).rejects.toThrow('파일이 없습니다: .env')
    await expect(ops.copyFileInto('/w/t', '../.env', '/keep')).rejects.toThrow('상대 경로')
  })

  it('worktree 삭제 전: 이 PC 의 ssh 터미널과 원격 tmux 세션을 끝낸다', async () => {
    const { tauri, ops } = setup(PROBE, { ptyKillByCwd: async () => 2 })
    expect(await ops.ptyKillByCwd('/w/t')).toBe(2)
    expect(tauri.ptyKillByCwd).toHaveBeenCalledWith('/w/t', 'my-server')
    const [, argv, opts] = tauri.sshExec.mock.calls[0]
    expect(argv).toEqual(['sh', '-s', '--', '/w/t'])
    expect(opts?.stdin).toContain('kill-session')
  })

  it('tmux 가 없는 호스트는 원격 세션 정리를 건너뛴다', async () => {
    const { tauri, ops } = setup({ ...PROBE, tmux: false })
    await ops.ptyKillByCwd('/w/t')
    expect(tauri.sshExec).not.toHaveBeenCalled()
  })

  it('스크립트·home·platform 은 원격 것', async () => {
    const { tauri, ops } = setup({ ...PROBE, platform: 'darwin', home: '/Users/dev' })
    const req = { runId: 'r1', cwd: '/w/t', script: 'echo hi', env: {} }
    await ops.scriptRun(req)
    expect(tauri.sshScriptRun).toHaveBeenCalledWith('my-server', req)
    expect(await ops.homeDir()).toBe('/Users/dev')
    expect(await ops.platform()).toBe('darwin')
    await expect(ops.openDir('/w')).rejects.toThrow('원격 폴더')
  })
})

describe('ssh 오류', () => {
  it('reject 값과 문자열 형식 모두 종류를 읽는다', () => {
    expect(sshErrorOf({ kind: 'auth', message: 'Permission denied (publickey).' })).toEqual({ kind: 'auth', message: 'Permission denied (publickey).' })
    expect(sshErrorOf('ssh(host_key): Host key verification failed.')).toEqual({ kind: 'host_key', message: 'Host key verification failed.' })
    expect(sshErrorOf(new Error('boom'))).toEqual({ kind: 'failed', message: 'boom' })
    expect(sshErrorOf({ kind: 'weird', message: 'x' }).kind).toBe('failed')
  })

  it('원인별로 다음에 할 일을 안내한다', () => {
    expect(sshErrorText('srv', { kind: 'host_key', message: '' })).toContain('`ssh srv` 로 한 번 접속')
    expect(sshErrorText('srv', { kind: 'auth', message: '' })).toContain('ssh-agent')
    expect(sshErrorText('srv', { kind: 'unsupported_os', message: '지원하지 않는 OS: FreeBSD' })).toContain('Linux·macOS 만')
    expect(sshErrorText('srv', { kind: 'no_git', message: '' })).toContain('git 을 설치')
  })
})
