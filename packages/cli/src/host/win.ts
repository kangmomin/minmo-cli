// Windows 프로세스 정리 — 다른 프로세스의 cwd 를 읽을 수 없어, 실행 파일 경로·명령줄에 worktree 경로가 들어간
// 프로세스(와 그 자손)를 찾아 taskkill /T /F 로 끝낸다. 무관한 프로그램을 끝내지 않게:
// - 창이 있는 프로세스(VS Code·IDE·편집기 등)는 끝내지 않고 "직접 닫으세요"로 알린다(저장하지 않은 내용을 잃지 않게)
// - minmo 와 다른 Windows 세션의 프로세스(SSH 로 접속했을 때의 데스크탑 앱, 다른 사용자)는 건드리지 않는다
// 끝낸 뒤에도 폴더를 누가 쓰고 있으면(경로가 명령줄에 없는 셸·편집기) git 이 내용만 지우고 멈추기 전에 중단한다.
import { rename } from 'node:fs/promises'

import { descendants, run } from './proc'

export type WinProcess = {
  pid: number
  ppid: number
  name: string
  exe: string
  cmd: string
  session: number
  /** 생성 시각(FILETIME) — PID 재사용으로 엉뚱한 부모를 잇지 않게 */
  created: number
  /** 보이는 창이 있음(같은 세션에서만 알 수 있다) */
  window: boolean
}

// 파이프로 받을 때 PowerShell 5.1 은 OEM 코드 페이지(예: cp949)로 내보내므로 UTF-8 로 바꿔야 한글 경로가 깨지지 않는다
const LIST_SCRIPT = [
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '$w=@{}; Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $w[$_.Id]=$true }',
  'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p=$_.ProcessId; pp=$_.ParentProcessId; n=$_.Name; e=$_.ExecutablePath; c=$_.CommandLine; s=$_.SessionId; t=$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }); w=$w.ContainsKey([int]$_.ProcessId) } } | ConvertTo-Json -Compress',
].join('; ')

type RawProcess = { p: number; pp: number; n: string | null; e: string | null; c: string | null; s: number | null; t: number | null; w: boolean }

export function parseProcessList(json: string): WinProcess[] {
  const raw = JSON.parse(json.trim() || '[]') as RawProcess | RawProcess[]
  return (Array.isArray(raw) ? raw : [raw]).map((p) => ({
    pid: p.p,
    ppid: p.pp,
    name: p.n ?? '',
    exe: p.e ?? '',
    cmd: p.c ?? '',
    session: p.s ?? -1,
    created: p.t ?? 0,
    window: !!p.w,
  }))
}

export async function listProcesses(): Promise<WinProcess[]> {
  // WMI 가 멈춰 있으면 삭제가 끝없이 기다리지 않게
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT], { timeoutMs: 30_000 })
  if (r.code !== 0) throw new Error(`프로세스 목록을 읽을 수 없습니다(PowerShell·WMI): ${r.stderr.trim() || `종료 코드 ${r.code}`}`)
  return parseProcessList(r.stdout)
}

/** 비교용: 구분자를 `\` 로, 소문자로, 끝 구분자 제거 */
export const winNorm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

export const insideWin = (child: string, parent: string) => {
  const c = winNorm(child)
  const p = winNorm(parent)
  return c === p || c.startsWith(`${p}\\`)
}

// 경로 뒤에 오면 경로가 끝난 것으로 보는 문자 — `issue-1.bak`·`issue-10` 처럼 이름이 이어지는 경우는 제외
const BOUNDARY = /[\\"'\s;,)\]|>]/

/** 명령줄·실행 경로가 dir(또는 하위)을 가리키는가 */
export function mentionsDir(p: Pick<WinProcess, 'exe' | 'cmd'>, dir: string): boolean {
  const d = winNorm(dir)
  return [p.exe, p.cmd].some((text) => {
    const t = text.replace(/\//g, '\\').toLowerCase()
    for (let i = t.indexOf(d); i >= 0; i = t.indexOf(d, i + 1)) {
      const next = t[i + d.length]
      if (next === undefined || BOUNDARY.test(next)) return true
    }
    return false
  })
}

/** 부모 링크는 부모가 먼저 생겼을 때만 — 부모가 끝나고 PID 가 재사용됐으면 잇지 않는다 */
function parentLinks(procs: WinProcess[]) {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const parentOf = (p: WinProcess) => {
    const par = byPid.get(p.ppid)
    return par && par.pid !== p.pid && par.created <= p.created ? par : undefined
  }
  return { byPid, parentOf }
}

/** pid 와 그 조상 */
export function ancestorsOf(pid: number, procs: WinProcess[]): Set<number> {
  const { byPid, parentOf } = parentLinks(procs)
  const out = new Set<number>([pid])
  let cur = byPid.get(pid)
  while (cur) {
    const par = parentOf(cur)
    if (!par || out.has(par.pid)) break
    out.add(par.pid)
    cur = par
  }
  return out
}

export type KillPlan = { roots: WinProcess[]; skipped: WinProcess[]; refuse: boolean }

/**
 * 끝낼 프로세스 트리의 뿌리를 고른다. 창이 있거나 다른 세션인 것은 skipped(직접 닫도록 알림).
 * 자신이 그 트리 안이면(worktree 안 프로세스가 띄운 셸에서 실행) refuse.
 */
export function planKill(dir: string, procs: WinProcess[], self: number): KillPlan {
  const { byPid, parentOf } = parentLinks(procs)
  const mine = ancestorsOf(self, procs)
  const session = byPid.get(self)?.session
  const tree = new Map<number, number[]>()
  for (const p of procs) {
    const par = parentOf(p)
    if (par) tree.set(par.pid, [...(tree.get(par.pid) ?? []), p.pid])
  }
  // 자신의 명령줄에 경로가 있는 것(예: 경로를 인자로 받은 실행)은 대상이 아니다
  const candidates = procs.filter((p) => p.pid !== self && mentionsDir(p, dir))
  const skip = (p: WinProcess) => p.window || (session !== undefined && p.session !== session)
  const roots = candidates.filter((p) => !skip(p))
  const skipped = candidates.filter(skip)
  // 대상 트리를 끝내면 자신도 끝난다 — 시작 전에 막는다
  const refuse = descendants(
    roots.map((p) => p.pid),
    tree,
  ).some((p) => mine.has(p))
  return { roots: refuse ? [] : roots, skipped, refuse }
}

const REFUSE = '지우려는 worktree 의 터미널(또는 그 안의 프로세스)에서 실행 중입니다 — 다른 터미널·폴더에서 실행하세요'

export type CleanupReport = { killed: string[]; skipped: string[] }
const label = (p: WinProcess) => `${p.name || 'pid'}(${p.pid})`

/**
 * git 이 지우기 전에 폴더가 쓰이고 있는지 본다 — Windows 는 쓰이는 폴더를 지우다 실패하면 내용만 지워진 채 남고,
 * git 은 worktree 기록만 지워 다시 지울 수도 없게 된다. 이름을 바꿨다 되돌려 보는 것으로 확인한다.
 */
async function assertNotInUse(dir: string, skipped: WinProcess[]): Promise<void> {
  const probe = `${dir}.minmo-rm-check`
  try {
    await rename(dir, probe)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return
    const open = skipped.length ? ` 열려 있는 창: ${skipped.map(label).join(', ')}.` : ''
    throw new Error(`worktree 폴더를 다른 프로그램이 쓰고 있습니다(${code}).${open} 그 폴더에서 연 터미널·편집기를 닫고 다시 시도하세요`)
  }
  try {
    await rename(probe, dir)
  } catch (e) {
    throw new Error(`폴더 이름을 되돌리지 못했습니다: ${probe} → ${dir} (${e instanceof Error ? e.message : String(e)})`)
  }
}

/** worktree(또는 하위)에서 돌던 프로세스 트리를 끝내고, 폴더를 지울 수 있는지 확인한다 */
export async function killInDir(dir: string, opts: { self?: number; cwd?: string } = {}): Promise<CleanupReport> {
  // Windows 는 cwd 로 잡힌 폴더를 지울 수 없다 — 삭제가 중간에 멈추기 전에 막는다
  if (insideWin(opts.cwd ?? process.cwd(), dir)) throw new Error(REFUSE)
  const plan = planKill(dir, await listProcesses(), opts.self ?? process.pid)
  if (plan.refuse) throw new Error(REFUSE)
  for (const p of plan.roots) await run('taskkill', ['/PID', String(p.pid), '/T', '/F'])
  // 끝난 프로세스가 잡고 있던 파일 핸들이 풀릴 시간
  if (plan.roots.length > 0) await new Promise((r) => setTimeout(r, 300))
  await assertNotInUse(dir, plan.skipped)
  return { killed: plan.roots.map(label), skipped: plan.skipped.map(label) }
}

/** 스크립트 취소용: 프로세스 트리 강제 종료 */
export function taskkillTree(pid: number): Promise<unknown> {
  return run('taskkill', ['/PID', String(pid), '/T', '/F'])
}
