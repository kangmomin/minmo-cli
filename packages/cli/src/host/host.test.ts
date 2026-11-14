import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { copyPaths, copyTree, guardRoot, removeDir } from './fsops'
import { descendants, run } from './proc'
import { createScriptHost } from './script'
import { sessionName } from './tmux'

const posix = process.platform !== 'win32'

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'minmo-host-'))
}

describe('파일 작업 (데스크탑 Rust 와 같은 규칙)', () => {
  it('guardRoot: 상대·얕은·.. 경로 거부', () => {
    expect(() => guardRoot('rel/a/b')).toThrow()
    expect(() => guardRoot(posix ? '/a' : 'C:\\a')).toThrow()
    // join 은 .. 를 풀어 버리므로 문자열로 만든다
    expect(() => guardRoot(`${tmpdir()}/a/../..`)).toThrow()
  })

  it('copyTree: 중첩 경로 복사, 기존 파일은 덮지 않음, 없는 원본은 0', async () => {
    const base = await tmp()
    const src = join(base, '_local')
    const dst = join(base, 'wt')
    await mkdir(join(src, 'config'), { recursive: true })
    await mkdir(dst, { recursive: true })
    await writeFile(join(src, '.env'), 'A=1')
    await writeFile(join(src, 'config', 'local.json'), '{}')
    await writeFile(join(dst, '.env'), 'A=checked-in')
    expect(await copyTree(src, dst)).toBe(1)
    expect(await readFile(join(dst, '.env'), 'utf8')).toBe('A=checked-in')
    expect(await readFile(join(dst, 'config', 'local.json'), 'utf8')).toBe('{}')
    expect(await copyTree(join(base, 'none'), dst)).toBe(0)
    await rm(base, { recursive: true, force: true })
  })

  it.skipIf(!posix)('copyTree: 대상 경로에 링크가 끼면 건너뛴다(worktree 밖에 쓰지 않음)', async () => {
    const base = await tmp()
    const src = join(base, '_local')
    const dst = join(base, 'wt')
    const outside = join(base, 'outside')
    await mkdir(join(src, 'config'), { recursive: true })
    await mkdir(dst, { recursive: true })
    await mkdir(outside)
    await writeFile(join(src, 'config', 'local.json'), '{}')
    await symlink(outside, join(dst, 'config'))
    expect(await copyTree(src, dst)).toBe(0)
    await expect(readFile(join(outside, 'local.json'))).rejects.toThrow()
    await rm(base, { recursive: true, force: true })
  })

  it('copyPaths: 지정한 파일·폴더만 복사, 기존 파일 유지, 없는 경로는 건너뜀, 밖을 가리키는 경로는 거부', async () => {
    const base = await tmp()
    const src = join(base, 'main')
    const dst = join(base, 'wt')
    await mkdir(join(src, '.venv', 'bin'), { recursive: true })
    await mkdir(join(src, 'node_modules', 'x'), { recursive: true })
    await mkdir(join(src, 'apps', 'web'), { recursive: true })
    await mkdir(dst, { recursive: true })
    await writeFile(join(src, '.env'), 'A=1')
    await writeFile(join(src, '.venv', 'bin', 'python'), 'py')
    await writeFile(join(src, 'node_modules', 'x', 'i.js'), 'x')
    await writeFile(join(src, 'apps', 'web', '.env.local'), 'B=2')
    await writeFile(join(src, 'tracked.txt'), 't')
    await writeFile(join(dst, '.env'), 'A=mine')
    expect(await copyPaths(src, dst, ['.env', '.venv', 'apps/web/.env.local', 'gone'])).toBe(2)
    expect(await readFile(join(dst, '.env'), 'utf8')).toBe('A=mine')
    expect(await readFile(join(dst, '.venv', 'bin', 'python'), 'utf8')).toBe('py')
    expect(await readFile(join(dst, 'apps', 'web', '.env.local'), 'utf8')).toBe('B=2')
    await expect(readFile(join(dst, 'node_modules', 'x', 'i.js'))).rejects.toThrow()
    await expect(readFile(join(dst, 'tracked.txt'))).rejects.toThrow()
    for (const bad of ['../outside', 'a/../../b', '/etc/passwd', '']) await expect(copyPaths(src, dst, [bad])).rejects.toThrow('허용되지 않는')
    await rm(base, { recursive: true, force: true })
  })

  it('copyPaths: 폴더 안의 제외 이름·.git 은 내려가지 않는다(대소문자는 OS 규칙) · 확인과 복사 사이에 생긴 파일도 덮지 않는다', async () => {
    const base = await tmp()
    const src = join(base, 'main')
    const dst = join(base, 'wt')
    await mkdir(join(src, 'tmp', 'pkg', 'node_modules', 'x'), { recursive: true })
    await mkdir(join(src, 'tmp', 'nested', '.git'), { recursive: true })
    await mkdir(dst, { recursive: true })
    await writeFile(join(src, 'tmp', 'keep.txt'), 'k')
    await writeFile(join(src, 'tmp', 'pkg', 'a.js'), 'a')
    await writeFile(join(src, 'tmp', 'pkg', 'node_modules', 'x', 'i.js'), 'x')
    await writeFile(join(src, 'tmp', 'nested', '.git', 'config'), 'c')
    await writeFile(join(src, 'tmp', 'nested', 'file'), 'f')
    expect(await copyPaths(src, dst, ['tmp'], ['node_modules'])).toBe(3)
    await expect(readFile(join(dst, 'tmp', 'pkg', 'node_modules', 'x', 'i.js'))).rejects.toThrow()
    await expect(readFile(join(dst, 'tmp', 'nested', '.git', 'config'))).rejects.toThrow()
    expect(await readFile(join(dst, 'tmp', 'nested', 'file'), 'utf8')).toBe('f')
    await rm(base, { recursive: true, force: true })
  })

  it.skipIf(!posix)('copyPaths: `:` 이 든 이름은 복사하고, 읽지 못하는 폴더가 있어도 나머지는 복사한 뒤 실패를 알린다', async () => {
    const base = await tmp()
    const src = join(base, 'main')
    const dst = join(base, 'wt')
    await mkdir(join(src, 'logs'), { recursive: true })
    await mkdir(join(src, 'locked'), { recursive: true })
    await mkdir(dst, { recursive: true })
    await writeFile(join(src, 'logs', '2026-11-14T10:00:00.log'), 'l')
    await writeFile(join(src, '.env'), 'A=1')
    await writeFile(join(src, 'locked', 'x'), 'x')
    expect(await copyPaths(src, dst, ['logs/2026-11-14T10:00:00.log'])).toBe(1)
    await chmod(join(src, 'locked'), 0o000)
    // root 로 돌면 권한이 막히지 않는다 — 그때는 실패 없이 모두 복사된다
    const run = copyPaths(src, dst, ['locked', '.env'])
    if (process.getuid?.() === 0) expect(await run).toBe(2)
    else await expect(run).rejects.toThrow(/1개 복사, 1개 실패 — locked/)
    expect(await readFile(join(dst, '.env'), 'utf8')).toBe('A=1')
    await chmod(join(src, 'locked'), 0o700)
    await rm(base, { recursive: true, force: true })
  })

  it.skipIf(!posix)('copyPaths: 원본·대상 어느 쪽이든 링크는 따라가지 않는다', async () => {
    const base = await tmp()
    const src = join(base, 'main')
    const dst = join(base, 'wt')
    const outside = join(base, 'outside')
    await mkdir(src, { recursive: true })
    await mkdir(dst, { recursive: true })
    await mkdir(outside)
    await writeFile(join(outside, 'secret'), 's')
    await symlink(outside, join(src, 'linked'))
    await symlink(join(outside, 'secret'), join(src, '.env'))
    expect(await copyPaths(src, dst, ['linked', 'linked/secret', '.env'])).toBe(0)
    await rm(base, { recursive: true, force: true })
  })

  it('removeDir: 홈·얕은 경로 거부, 깊은 경로는 삭제', async () => {
    const base = await tmp()
    const deep = join(base, 'a', 'b')
    // Linux 의 /tmp/x 는 얕아서 홈 검사보다 깊이 검사에 먼저 걸리므로 홈을 깊게 둔다
    const home = join(base, 'home', 'u')
    await mkdir(deep, { recursive: true })
    await mkdir(home, { recursive: true })
    await expect(removeDir(home, home)).rejects.toThrow('홈 디렉터리')
    await removeDir(deep)
    await expect(readFile(deep)).rejects.toThrow()
    await rm(base, { recursive: true, force: true })
  })
})

describe('프로세스', () => {
  it('run: 0 이 아닌 종료는 code 로, 없는 명령은 127', async () => {
    const r = await run(process.execPath, ['-e', 'process.stderr.write("e");process.exit(3)'])
    expect(r).toEqual({ code: 3, stdout: '', stderr: 'e' })
    expect((await run('minmo-no-such-command-xyz', [])).code).toBe(127)
  })

  it('descendants: 자손 트리를 모은다(순환 안전)', () => {
    const tree = new Map([
      [1, [2, 3]],
      [2, [4]],
      [4, [1]],
    ])
    expect(descendants([2], tree).sort()).toEqual([1, 2, 3, 4])
  })

  it('tmux 세션 이름은 경로로 결정적', () => {
    expect(sessionName('/a/b')).toBe(sessionName('/a/b/'))
    expect(sessionName('/a/b')).not.toBe(sessionName('/a/c'))
    expect(sessionName('/a/b')).toMatch(/^minmo-[0-9a-f]{10}$/)
  })
})

describe.skipIf(!posix)('생성 후 스크립트(sh)', () => {
  it('set -e · env · 줄 단위 로그 · 종료 코드', async () => {
    const host = createScriptHost()
    const lines: string[] = []
    await host.onScriptLog((e) => lines.push(`${e.stream}:${e.line}`))
    const cwd = await tmp()
    const r = await host.scriptRun({ runId: 'r1', cwd, script: 'echo "$MINMO_REPO"\nfalse\necho never', env: { MINMO_REPO: 'w' } })
    expect(r).toEqual({ exitCode: 1, cancelled: false })
    expect(lines).toEqual(['stdout:w'])
  })

  it('취소하면 프로세스 그룹을 끝내고 cancelled', async () => {
    const host = createScriptHost()
    const cwd = await tmp()
    const done = host.scriptRun({ runId: 'r2', cwd, script: 'sleep 30 & sleep 30', env: {} })
    await new Promise((r) => setTimeout(r, 200))
    await host.scriptCancel('r2')
    await expect(done).resolves.toEqual({ exitCode: null, cancelled: true })
  })
})

const hasTmux = posix && (await run('tmux', ['-V'])).code === 0

describe.skipIf(!hasTmux)('tmux 세션 정리(실제 tmux)', () => {
  it('태그로 세션을 찾아 그 안의 프로세스만 끝내고, worktree 안에서 띄운 tmux 서버·다른 세션은 남긴다', async () => {
    const { ensureSession, killByCwd, listSessions } = await import('./tmux')
    const base = await tmp()
    const wt = join(base, 'acme', 'w|t') // 경로의 '|' 도 다룬다
    await mkdir(wt, { recursive: true })
    // 서버를 worktree 안에서 처음 띄운다(서버 cwd = worktree)
    await run('tmux', ['-L', 'minmo', 'new-session', '-d', '-s', 'other-test', '-c', tmpdir()], { cwd: wt })
    const name = await ensureSession(wt, 'test')
    const sessions = await listSessions()
    const mine = sessions.find((s) => s.name === name)!
    expect(mine.worktree).toBe(wt)
    expect(Number.isInteger(mine.serverPid)).toBe(true)
    await run('tmux', ['-L', 'minmo', 'send-keys', '-t', `=${name}`, 'sleep 1011 & setsid sleep 1012 &', 'Enter'])
    await new Promise((r) => setTimeout(r, 800))
    expect(await killByCwd(wt)).toBe(1)
    expect((await run('pgrep', ['-f', 'sleep 101[12]'])).code).toBe(1)
    expect(() => process.kill(mine.serverPid, 0)).not.toThrow()
    expect((await listSessions()).map((s) => s.name)).toContain('other-test')
    await run('tmux', ['-L', 'minmo', 'kill-session', '-t', '=other-test'])
    await rm(base, { recursive: true, force: true })
  })
})
