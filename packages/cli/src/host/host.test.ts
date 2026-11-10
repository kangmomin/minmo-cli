import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { copyTree, guardRoot, removeDir } from './fsops'
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
