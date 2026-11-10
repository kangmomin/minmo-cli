// Windows 프로세스 정리 — 다른 프로세스의 cwd 를 읽을 수 없어, 실행 파일 경로·명령줄에 worktree 경로가 들어간
// 프로세스(와 그 자손)를 찾아 taskkill /T /F 로 끝낸다. 경로가 명령줄에 없는 고아는 놓칠 수 있다 — 그때는
// git worktree remove 가 "사용 중" 으로 실패해 알 수 있다.
import { descendants, run } from './proc'

export type WinProcess = { pid: number; ppid: number; exe: string; cmd: string }

// 파이프로 받을 때 PowerShell 5.1 은 OEM 코드 페이지(예: cp949)로 내보내므로 UTF-8 로 바꿔야 한글 경로가 깨지지 않는다
const LIST_SCRIPT =
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'

type RawProcess = { ProcessId: number; ParentProcessId: number; ExecutablePath: string | null; CommandLine: string | null }

export function parseProcessList(json: string): WinProcess[] {
  const raw = JSON.parse(json.trim() || '[]') as RawProcess | RawProcess[]
  return (Array.isArray(raw) ? raw : [raw]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, exe: p.ExecutablePath ?? '', cmd: p.CommandLine ?? '' }))
}

export async function listProcesses(): Promise<WinProcess[]> {
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT])
  if (r.code !== 0) throw new Error(`프로세스 목록을 읽을 수 없습니다: ${r.stderr.trim()}`)
  return parseProcessList(r.stdout)
}

/** 비교용: 구분자를 `\` 로, 소문자로, 끝 구분자 제거 */
export const winNorm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

export const insideWin = (child: string, parent: string) => {
  const c = winNorm(child)
  const p = winNorm(parent)
  return c === p || c.startsWith(`${p}\\`)
}

/** 명령줄·실행 경로가 dir(또는 하위)을 가리키는가 — `C:\w\issue-1` 이 `C:\w\issue-10` 에 걸리지 않게 경로 뒤 구분을 본다 */
export function mentionsDir(p: Pick<WinProcess, 'exe' | 'cmd'>, dir: string): boolean {
  const d = winNorm(dir)
  return [p.exe, p.cmd].some((text) => {
    const t = text.replace(/\//g, '\\').toLowerCase()
    for (let i = t.indexOf(d); i >= 0; i = t.indexOf(d, i + 1)) {
      const next = t[i + d.length]
      if (next === undefined || next === '\\' || next === '"' || next === "'" || /\s/.test(next)) return true
    }
    return false
  })
}

/** pid 와 그 조상(ParentProcessId 체인) — pid 가 재사용돼 순환할 수 있어 본 것은 건너뛴다 */
export function ancestorsOf(pid: number, procs: WinProcess[]): Set<number> {
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]))
  const out = new Set<number>()
  for (let cur: number | undefined = pid; cur !== undefined && cur > 0 && !out.has(cur); cur = parent.get(cur)) out.add(cur)
  return out
}

export type KillPlan = { roots: number[]; refuse: boolean }

/** 끝낼 프로세스 트리의 뿌리를 고른다. 자신·조상이 그 트리 안이면(worktree 안 프로세스에서 실행) refuse */
export function planKill(dir: string, procs: WinProcess[], self: number): KillPlan {
  const mine = ancestorsOf(self, procs)
  const tree = new Map<number, number[]>()
  for (const p of procs) tree.set(p.ppid, [...(tree.get(p.ppid) ?? []), p.pid])
  // 자신의 명령줄에 경로가 있는 것(예: 경로를 인자로 받은 실행)은 대상이 아니다
  const roots = procs.filter((p) => p.pid !== self && mentionsDir(p, dir)).map((p) => p.pid)
  // 조상이 대상이거나(그 트리를 끝내면 자신도 끝난다) 대상 트리 안에 자신이 있으면 거부
  const refuse = descendants(roots, tree).some((p) => mine.has(p))
  return { roots: refuse ? [] : roots, refuse }
}

const REFUSE = '지우려는 worktree 의 터미널(또는 그 안의 프로세스)에서 실행 중입니다 — 다른 터미널·폴더에서 실행하세요'

/** worktree(또는 하위)에서 돌던 프로세스 트리를 끝낸다. 끝낸 트리 수를 돌려준다 */
export async function killInDir(dir: string, opts: { self?: number; cwd?: string } = {}): Promise<number> {
  // Windows 는 cwd 로 잡힌 폴더를 지울 수 없다 — 삭제가 중간에 멈추기 전에 막는다
  if (insideWin(opts.cwd ?? process.cwd(), dir)) throw new Error(REFUSE)
  const plan = planKill(dir, await listProcesses(), opts.self ?? process.pid)
  if (plan.refuse) throw new Error(REFUSE)
  for (const pid of plan.roots) await run('taskkill', ['/PID', String(pid), '/T', '/F'])
  // 끝난 프로세스가 잡고 있던 파일 핸들이 풀릴 시간
  if (plan.roots.length > 0) await new Promise((r) => setTimeout(r, 300))
  return plan.roots.length
}

/** 스크립트 취소용: 프로세스 트리 강제 종료 */
export function taskkillTree(pid: number): Promise<unknown> {
  return run('taskkill', ['/PID', String(pid), '/T', '/F'])
}
