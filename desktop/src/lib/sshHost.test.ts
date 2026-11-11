// 원격 호스트 구현 — 명령 구성·안전 조건·tmux 세션 이름·오류 안내
import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { createFakeTauri, fail, ok } from '../test/fakes'
import { assertRelative, assertRemovable, assertRoot, gitSubcommand, createSshOps, remotePty, sha1Hex, sshErrorOf, sshErrorText, tmuxSessionName } from './sshHost'
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

  it('pathExists 는 test -e 의 종료 코드로 판단한다 — 1 만 없음, 그 밖의 실패는 오류', async () => {
    const { ops } = setup(PROBE, { sshExec: async (_h, argv) => (argv[2] === '/yes' ? ok() : argv[2] === '/no' ? fail('', 1) : fail('sh: not found', 127)) })
    expect(await ops.pathExists('/yes')).toBe(true)
    expect(await ops.pathExists('/no')).toBe(false)
    await expect(ops.pathExists('/broken')).rejects.toThrow('sh: not found')
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
    expect(await ops.listFiles('/ws/o/r/_local')).toEqual(['.env', 'config/local.json'])
    expect(await ops.copyTree('/ws/o/r/_local', '/ws/o/r/t')).toBe(2)
    const [, argv, opts] = tauri.sshExec.mock.calls[1]
    expect(argv).toEqual(['sh', '-s', '--', '/ws/o/r/_local', '/ws/o/r/t'])
    // 경로가 스크립트 본문에 섞이지 않는다(따옴표·공백이 있어도 안전)
    expect(opts?.stdin).not.toContain('_local')
  })

  it('얕은 폴더(홈·루트)에서는 파일 작업을 하지 않는다', async () => {
    const { tauri, ops } = setup()
    for (const root of ['/', '/home/dev', 'rel/a/b/c', '/a/b/../c']) expect(() => assertRoot(root)).toThrow('사용할 수 없는 폴더')
    await expect(ops.listFiles('/home/dev')).rejects.toThrow('사용할 수 없는 폴더')
    await expect(ops.removeFileIn('/home', '.env')).rejects.toThrow('사용할 수 없는 폴더')
    await expect(ops.copyTree('/ws/o/r/_local', '/')).rejects.toThrow('사용할 수 없는 폴더')
    expect(tauri.sshExec).not.toHaveBeenCalled()
  })

  it('보관 실패는 원격 stderr 를 오류로 돌려준다', async () => {
    const { ops } = setup(PROBE, { sshExec: async () => fail('파일이 없습니다: .env') })
    await expect(ops.copyFileInto('/ws/o/r/t', '.env', '/ws/o/r/_local')).rejects.toThrow('파일이 없습니다: .env')
    await expect(ops.copyFileInto('/ws/o/r/t', '../.env', '/ws/o/r/_local')).rejects.toThrow('상대 경로')
  })

  it('worktree 삭제 전: 이 PC 의 ssh 터미널과 원격 tmux 세션을 끝낸다', async () => {
    const { tauri, ops } = setup(PROBE, { ptyKillByCwd: async () => 2 })
    expect(await ops.ptyKillByCwd('/w/t')).toBe(2)
    expect(tauri.ptyKillByCwd).toHaveBeenCalledWith('/w/t', 'my-server')
    const [, argv, opts] = tauri.sshExec.mock.calls[0]
    expect(argv).toEqual(['sh', '-s', '--', '/w/t', tmuxSessionName('/w/t')])
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

describe('원격 git 인증(토큰 전달)', () => {
  it('토큰은 stdin 으로만 보낸다 — 명령줄(argv)·환경 변수 인자에는 없다', async () => {
    const { tauri } = createFakeTauri()
    const ops = createSshOps(tauri, 'my-server', PROBE, async () => 'gho_SECRET')
    await ops.gitRun(['-C', '/ws/o/r/_main', 'fetch', 'origin'])
    const [, argv, opts] = tauri.sshExec.mock.calls[0]
    expect(argv.slice(0, 2)).toEqual(['sh', '-c'])
    expect(argv.slice(3)).toEqual(['sh', '-C', '/ws/o/r/_main', 'fetch', 'origin'])
    expect(opts?.stdin).toBe('gho_SECRET\n')
    expect(JSON.stringify(argv)).not.toContain('gho_SECRET')
    expect(JSON.stringify(opts?.env)).not.toContain('gho_SECRET')
    // github.com 에만, 이 명령에만 적용되고 원격의 helper(저장)는 쓰지 않는다
    expect(argv[2]).toContain('credential.https://github.com.helper=')
    expect(argv[2]).toContain('exec git')
  })

  it('토큰이 없거나 얻지 못하면 원격 자체의 자격 증명으로 실행한다', async () => {
    for (const getToken of [async () => null, async () => Promise.reject(new Error('offline')), async () => 'bad\ntoken']) {
      const { tauri } = createFakeTauri()
      await createSshOps(tauri, 'my-server', PROBE, getToken).gitRun(['push', 'origin', 'main'])
      expect(tauri.sshExec).toHaveBeenCalledWith('my-server', ['git', 'push', 'origin', 'main'], { cwd: undefined, env: { GIT_TERMINAL_PROMPT: '0' } })
    }
  })

  it('GitHub 와 통신하는 명령에만 넘긴다 — status·diff·commit 등에는 토큰을 묻지도 보내지도 않는다', async () => {
    const getToken = vi.fn(async () => 'gho_SECRET')
    const { tauri } = createFakeTauri()
    const ops = createSshOps(tauri, 'my-server', PROBE, getToken)
    for (const args of [['-C', '/w', 'status', '--porcelain'], ['-C', '/w', 'diff', '--', 'a'], ['-C', '/w', 'commit', '-m', 'push it'], ['-c', 'x.y=fetch', 'rev-parse', 'HEAD']]) {
      await ops.gitRun(args)
    }
    expect(getToken).not.toHaveBeenCalled()
    expect(tauri.sshExec.mock.calls.every(([, argv, o]) => argv[0] === 'git' && o?.stdin === undefined)).toBe(true)
    for (const args of [['clone', 'u', 'd'], ['-C', '/w', 'fetch', 'origin'], ['-C', '/w', 'worktree', 'add', 'p']]) await ops.gitRun(args)
    expect(getToken).toHaveBeenCalledTimes(3)
    expect(gitSubcommand(['-C', '/w', '-c', 'a=b', 'push'])).toBe('push')
    expect(gitSubcommand(['--version'])).toBeNull()
  })
})

describe('원격 파일 탭 작업', () => {
  const ROOT = '/ws/o/r/t'

  it('폴더 목록: 폴더 먼저·이름순, 링크 구분', async () => {
    const { ops } = setup(PROBE, { sshExec: async () => ok('f/b.txt\nd/src\nl/link\nf/A.md\nd/.github\n') })
    expect(await ops.listDir(ROOT, '')).toEqual([
      { name: '.github', kind: 'dir' },
      { name: 'src', kind: 'dir' },
      { name: 'A.md', kind: 'file' },
      { name: 'b.txt', kind: 'file' },
      { name: 'link', kind: 'link' },
    ])
  })

  it('읽기: 첫 줄은 version, 나머지가 내용(줄바꿈·CRLF 그대로) · 바이너리는 거부', async () => {
    const { ops } = setup(PROBE, { sshExec: async (_h, argv) => (argv[4] === 'bin' ? ok('1 3\n\uFFFD\uFFFD') : ok('123 9\nline1\r\n\nend')) })
    expect(await ops.readTextFile(ROOT, 'a.txt')).toEqual({ content: 'line1\r\n\nend', version: '123 9' })
    await expect(ops.readTextFile(ROOT, 'bin')).rejects.toThrow('file_binary')
  })

  it('쓰기: 내용은 stdin, 경로·version·create 는 인자 · 원격 오류 코드를 그대로 돌려준다', async () => {
    const { tauri, ops } = setup(PROBE, { sshExec: async (_h, argv) => (argv[5] === 'conflict.txt' ? fail('file_changed: 연 뒤에 파일이 바뀌었습니다') : ok('999 5\n')) })
    expect(await ops.writeTextFile(ROOT, 'dir/a.txt', 'hello', { expected: '123 9' })).toBe('999 5')
    const [, argv, opts] = tauri.sshExec.mock.calls[0]
    expect(argv.slice(0, 2)).toEqual(['sh', '-c'])
    expect(argv.slice(3)).toEqual(['sh', ROOT, 'dir/a.txt', '123 9', '0', '5'])
    expect(opts?.stdin).toBe('hello')
    // 바이트 수는 UTF-8 기준(전송이 끊겼는지 원격에서 확인한다)
    await ops.writeTextFile(ROOT, 'k.txt', '한글')
    expect(tauri.sshExec.mock.calls[1][1][8]).toBe('6')
    await expect(ops.writeTextFile(ROOT, 'conflict.txt', 'x', { expected: 'old' })).rejects.toThrow('file_changed')
    await ops.writeTextFile(ROOT, 'new.txt', '', { create: true })
    expect(tauri.sshExec.mock.calls[3][1].slice(3)).toEqual(['sh', ROOT, 'new.txt', '', '1', '0'])
  })

  it('루트 밖을 가리키는 경로는 원격에 보내지 않는다', async () => {
    const { tauri, ops } = setup()
    await expect(ops.readTextFile(ROOT, '../secret')).rejects.toThrow('상대 경로')
    await expect(ops.writeTextFile(ROOT, '/etc/passwd', 'x')).rejects.toThrow('상대 경로')
    await expect(ops.renamePath(ROOT, 'a', '../b')).rejects.toThrow('상대 경로')
    await expect(ops.removePath(ROOT, '')).rejects.toThrow('상대 경로')
    await expect(ops.listDir('/home/dev', '')).rejects.toThrow('사용할 수 없는 폴더')
    await expect(ops.createDir('/', 'x')).rejects.toThrow('사용할 수 없는 폴더')
    expect(tauri.sshExec).not.toHaveBeenCalled()
  })

  it('만들기·이름 바꾸기·삭제는 경로를 인자로 넘긴다', async () => {
    const { tauri, ops } = setup()
    await ops.createDir(ROOT, 'a/b')
    await ops.renamePath(ROOT, 'a/b', 'c d')
    await ops.removePath(ROOT, 'c d')
    expect(tauri.sshExec.mock.calls.map(([, argv]) => argv.slice(3))).toEqual([[ROOT, 'a/b'], [ROOT, 'a/b', 'c d'], [ROOT, 'c d']])
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
    expect(sshErrorText('srv', { kind: 'host_key', message: '' })).toContain('[호스트 키 등록하고 연결]')
    expect(sshErrorText('srv', { kind: 'auth', message: '' })).toContain('ssh-agent')
    expect(sshErrorText('srv', { kind: 'unsupported_os', message: '지원하지 않는 OS: FreeBSD' })).toContain('Linux·macOS 만')
    expect(sshErrorText('srv', { kind: 'no_git', message: '' })).toContain('git 을 설치')
  })
})
