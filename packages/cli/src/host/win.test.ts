// Windows 호스트: 프로세스 정리(명령줄·실행 경로 기준), PowerShell 스크립트, 터미널, 경로·설정 폴더.
// 순수 로직은 모든 OS 에서, 실제 PowerShell·taskkill 은 Windows 에서만 돌린다.
import { spawn } from 'node:child_process'
import type { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { defaultPaths } from '../store'
import { guardRoot } from './fsops'
import { createScriptHost, powershellScript } from './script'
import { openTerminal, windowsShellArgs } from './terminal'
import { killInDir, mentionsDir, parseProcessList, planKill } from './win'
import type { WinProcess } from './win'

const win = process.platform === 'win32'

describe('Windows 프로세스 정리 — 고르기(순수)', () => {
  const W = 'C:\\ws\\acme\\widgets\\issue-1'
  // 기본: 같은 세션(1), 창 없음, 생성 순서 = pid 순서
  const P = (pid: number, ppid: number, cmd = '', more: Partial<WinProcess> = {}): WinProcess => ({ pid, ppid, cmd, exe: '', name: 'x.exe', session: 1, created: pid, window: false, ...more })
  const pids = (ps: WinProcess[]) => ps.map((p) => p.pid)

  it('명령줄·실행 경로에 worktree 경로가 들어간 것만 — 대소문자·구분자 무시, issue-1 이 issue-10 에 걸리지 않는다', () => {
    expect(mentionsDir({ exe: '', cmd: 'node c:/ws/ACME/widgets/issue-1/server.js' }, W)).toBe(true)
    expect(mentionsDir({ exe: 'C:\\ws\\acme\\widgets\\issue-1\\node_modules\\.bin\\vite.exe', cmd: '' }, W)).toBe(true)
    expect(mentionsDir({ exe: '', cmd: `pwsh -wd "${W}"` }, W)).toBe(true)
    expect(mentionsDir({ exe: '', cmd: `pwsh -wd ${W}` }, W)).toBe(true)
    expect(mentionsDir({ exe: '', cmd: `x --paths=${W};C:\\other` }, W)).toBe(true)
    expect(mentionsDir({ exe: '', cmd: 'node C:\\ws\\acme\\widgets\\issue-10\\a.js' }, W)).toBe(false)
    expect(mentionsDir({ exe: '', cmd: `${W}.bak\\a.js` }, W)).toBe(false)
  })

  it('뿌리만 골라 트리째 끝내고, 자신·조상은 빼며, 자신이 대상 트리 안이면 거부', () => {
    const procs = [P(1, 0, 'explorer'), P(10, 1, `node ${W}\\dev.js`), P(11, 10, 'esbuild --service'), P(20, 1, 'pwsh'), P(21, 20, 'node minmo rm')]
    expect(pids(planKill(W, procs, 21).roots)).toEqual([10])
    // worktree 의 dev 서버가 띄운 셸에서 minmo 를 실행 — 트리를 끝내면 자신도 끝난다
    const inside = [...procs, P(30, 10, 'pwsh'), P(31, 30, 'node minmo rm')]
    expect(planKill(W, inside, 31)).toMatchObject({ roots: [], refuse: true })
    // minmo 가 연 터미널(명령줄에 경로)에서 실행해도 거부
    const term = [P(1, 0), P(50, 1, `powershell.exe -NoLogo -NoExit -Command Set-Location -LiteralPath '${W}'`), P(51, 50, 'node minmo rm')]
    expect(planKill(W, term, 51).refuse).toBe(true)
    // 자신의 명령줄에 경로가 있어도(예: minmo rm C:\ws\…) 자신은 대상이 아니다
    expect(planKill(W, [P(1, 0), P(40, 1, `node minmo open ${W}`)], 40)).toMatchObject({ roots: [], refuse: false })
  })

  it('창이 있는 프로세스(IDE·편집기)와 다른 세션의 프로세스는 끝내지 않고 skipped 로 알린다', () => {
    const procs = [
      P(1, 0),
      P(5, 1, 'node minmo rm'),
      P(10, 1, `Code.exe ${W}`, { name: 'Code.exe', window: true }),
      P(11, 10, `node ${W}\\server.js`, { name: 'node.exe' }),
      P(20, 1, `node ${W}\\other.js`, { name: 'node.exe', session: 0 }),
    ]
    const plan = planKill(W, procs, 5)
    expect(pids(plan.roots)).toEqual([11])
    expect(pids(plan.skipped)).toEqual([10, 20])
    // VS Code 터미널(창 있는 프로세스의 자손)에서 실행해도 VS Code 를 끝내려다 거부하지 않는다
    expect(planKill(W, [...procs, P(30, 10, 'pwsh'), P(31, 30, 'node minmo rm')], 31)).toMatchObject({ refuse: false })
  })

  it('PID 재사용: 부모가 자식보다 늦게 생겼으면 잇지 않는다(엉뚱한 거부 방지)', () => {
    // 100 은 자신(200)의 원래 부모가 끝난 뒤 재사용된 PID — worktree 안 프로세스지만 조상이 아니다
    const procs = [P(1, 0), P(100, 1, `node ${W}\\dev.js`, { created: 999 }), P(200, 100, 'node minmo rm', { created: 500 })]
    expect(planKill(W, procs, 200)).toMatchObject({ refuse: false })
    expect(pids(planKill(W, procs, 200).roots)).toEqual([100])
  })

  it('ConvertTo-Json 은 하나면 배열이 아니다', () => {
    expect(parseProcessList('{"p":4,"pp":0,"n":"System","e":null,"c":null,"s":0,"t":0,"w":false}')).toEqual([
      { pid: 4, ppid: 0, name: 'System', exe: '', cmd: '', session: 0, created: 0, window: false },
    ])
    expect(parseProcessList('')).toEqual([])
  })
})

describe('Windows 경로·설정 폴더·터미널', () => {
  it.skipIf(!win)('guardRoot: 드라이브는 세지 않는다(Rust fs.rs 와 같다)', () => {
    expect(() => guardRoot('C:\\a\\b')).toThrow()
    expect(guardRoot('C:\\a\\b\\c')).toBe('C:\\a\\b\\c')
  })

  it('설정 폴더: Windows 는 %APPDATA%\\minmo, XDG_CONFIG_HOME 이 우선', () => {
    expect(defaultPaths({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me', 'win32').configDir).toBe(join('C:\\Users\\me\\AppData\\Roaming', 'minmo'))
    expect(defaultPaths({ APPDATA: 'x', XDG_CONFIG_HOME: '/cfg' }, '/home/me', 'win32').configDir).toBe(join('/cfg', 'minmo'))
    expect(defaultPaths({ APPDATA: 'x' }, '/home/me', 'linux').configDir).toBe(join('/home/me', '.config', 'minmo'))
  })

  it('터미널: Windows 는 worktree 에서 PowerShell(pwsh 우선)을 연다 — MINMO_WORKTREE 를 남긴다', async () => {
    const calls: { cmd: string; args: readonly string[]; opts: Record<string, unknown> }[] = []
    const fake = ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts })
      return { status: cmd === 'pwsh' ? 0 : 1 }
    }) as unknown as typeof spawnSync
    const code = await openTerminal('C:\\ws\\a\\b\\etc', 'b#etc', { platform: 'win32', env: { PATH: 'p' }, spawn: fake })
    expect(code).toBe(0)
    const shell = calls.at(-1)!
    expect(shell.cmd).toBe('pwsh')
    // 경로를 명령줄에 남겨 삭제 때 이 셸을 찾을 수 있게(PowerShell 의 cd 는 프로세스 cwd 를 바꾸지 않는다)
    expect(shell.args).toEqual(['-NoLogo', '-NoExit', '-Command', "Set-Location -LiteralPath 'C:\\ws\\a\\b\\etc'"])
    // 경로 안의 작은따옴표는 PowerShell 규칙대로 두 번
    expect(windowsShellArgs("C:\\it's")[3]).toBe("Set-Location -LiteralPath 'C:\\it''s'")
    expect(shell.opts).toMatchObject({ cwd: 'C:\\ws\\a\\b\\etc', stdio: 'inherit', env: { PATH: 'p', MINMO_WORKTREE: 'C:\\ws\\a\\b\\etc' } })
    // pwsh 가 없으면 Windows 기본 PowerShell
    const noPwsh = vi.fn(() => ({ status: 1 })) as unknown as typeof spawnSync
    await openTerminal('C:\\w\\x\\y', 't', { platform: 'win32', env: {}, spawn: noPwsh })
    expect((noPwsh as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe('powershell.exe')
  })

  it('PowerShell 스크립트 파일: BOM·Stop·UTF-8·CRLF·마지막 종료 코드', () => {
    const s = powershellScript('npm ci\nWrite-Output 끝')
    expect([...s.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const body = s.subarray(3).toString('utf8')
    expect(body).toContain("$ErrorActionPreference = 'Stop'\r\n")
    expect(body).toContain('npm ci\r\nWrite-Output 끝\r\n')
    expect(body.endsWith('if ($LASTEXITCODE) { exit $LASTEXITCODE }\r\n')).toBe(true)
  })
})

describe.skipIf(!win)('Windows 실제 실행(PowerShell·taskkill)', () => {
  it('생성 후 스크립트: env·줄 단위 로그(한글)·오류에서 멈춤·종료 코드', async () => {
    const host = createScriptHost('win32')
    const lines: string[] = []
    await host.onScriptLog((e) => lines.push(`${e.stream}:${e.line}`))
    const cwd = await mkdtemp(join(tmpdir(), 'minmo-win-'))
    const ok = await host.scriptRun({ runId: 'w1', cwd, script: 'Write-Output "repo=$env:MINMO_REPO"\nWrite-Output 한글', env: { MINMO_REPO: 'widgets' } })
    expect(ok).toEqual({ exitCode: 0, cancelled: false })
    expect(lines).toEqual(['stdout:repo=widgets', 'stdout:한글'])
    // 네이티브 명령의 실패 코드를 넘기고, Stop 이라 다음 줄은 실행하지 않는다
    lines.length = 0
    const bad = await host.scriptRun({ runId: 'w2', cwd, script: 'cmd /c exit 3\nWrite-Output after', env: {} })
    expect(bad.exitCode).toBe(3)
    const thrown = await host.scriptRun({ runId: 'w3', cwd, script: 'throw "boom"\nWrite-Output never', env: {} })
    expect(thrown.exitCode).not.toBe(0)
    expect(lines.some((l) => l.includes('never'))).toBe(false)
  }, 30_000)

  it('취소하면 프로세스 트리를 끝내고 cancelled', async () => {
    const host = createScriptHost('win32')
    const cwd = await mkdtemp(join(tmpdir(), 'minmo-win-'))
    const done = host.scriptRun({ runId: 'w4', cwd, script: 'Start-Sleep -Seconds 30', env: {} })
    await new Promise((r) => setTimeout(r, 1500))
    await host.scriptCancel('w4')
    await expect(done).resolves.toEqual({ exitCode: null, cancelled: true })
  }, 30_000)

  it('killInDir: worktree 경로를 명령줄에 가진 프로세스를 끝내고, cwd 가 그 안이면 시작 전에 거부', async () => {
    const base = await mkdtemp(join(tmpdir(), 'minmo-win-'))
    const wt = join(base, 'acme', 'widgets', 'issue-7')
    await mkdir(wt, { recursive: true })
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(wt, 'dev.js')], { stdio: 'ignore' })
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
    await new Promise((r) => setTimeout(r, 300))
    await expect(killInDir(wt, { cwd: join(wt, 'sub') })).rejects.toThrow('worktree 의 터미널')
    expect(child.exitCode).toBeNull()
    const report = await killInDir(wt, { cwd: base })
    expect(report).toEqual({ killed: [`node.exe(${child.pid})`], skipped: [] })
    await exited
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  }, 30_000)

  it('명령줄에 경로가 없는 프로세스가 폴더를 잡고 있으면 git 이 지우기 전에 멈춘다(폴더는 그대로)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'minmo-win-'))
    const wt = join(base, 'acme', 'widgets', 'issue-8')
    await mkdir(wt, { recursive: true })
    // cwd 로만 폴더를 잡는 프로세스(예: PowerShell 에서 cd 한 셸) — 명령줄로는 찾을 수 없다
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: wt, stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 300))
      await expect(killInDir(wt, { cwd: base })).rejects.toThrow('worktree 폴더를 다른 프로그램이 쓰고 있습니다')
      expect(existsSync(wt)).toBe(true)
    } finally {
      holder.kill()
    }
  }, 30_000)
})
