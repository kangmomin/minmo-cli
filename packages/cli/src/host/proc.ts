// 자식 프로세스 실행과 프로세스 트리 정리(Linux·macOS).
import { spawn } from 'node:child_process'
import { readFile, readdir, readlink, stat } from 'node:fs/promises'

import type { CmdResult } from '@minmo/core'

/** 명령을 셸 없이 실행한다. 0 이 아닌 종료도 reject 하지 않고 code 로 돌려준다(없는 명령은 127) */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string } = {}): Promise<CmdResult> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: 127, stdout: '', stderr: e instanceof Error ? e.message : String(e) })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on('data', (c: Buffer) => out.push(c))
    child.stderr?.on('data', (c: Buffer) => err.push(c))
    child.on('error', (e) => resolve({ code: 127, stdout: '', stderr: e.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }))
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin)
  })
}

/** `ps -A -o pid=,ppid=` → 부모별 자식 목록 */
export async function processTree(): Promise<Map<number, number[]>> {
  const r = await run('ps', ['-A', '-o', 'pid=,ppid='])
  const children = new Map<number, number[]>()
  for (const line of r.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    const list = children.get(ppid) ?? []
    list.push(pid)
    children.set(ppid, list)
  }
  return children
}

export function descendants(roots: number[], tree: Map<number, number[]>): number[] {
  const out: number[] = []
  const stack = [...roots]
  const seen = new Set<number>()
  while (stack.length > 0) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    out.push(pid)
    stack.push(...(tree.get(pid) ?? []))
  }
  return out
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function signal(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(pid, sig)
  } catch {
    // 이미 끝났거나 권한 없음
  }
}

/** SIGTERM 을 보내고 graceMs 안에 끝나지 않은 것은 SIGKILL. 끝까지 남은 pid 목록을 돌려준다 */
export async function terminate(pids: number[], graceMs = 3000): Promise<number[]> {
  const targets = pids.filter((p) => p !== process.pid)
  for (const p of targets) signal(p, 'SIGTERM')
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && targets.some(alive)) await new Promise((r) => setTimeout(r, 50))
  const rest = targets.filter(alive)
  for (const p of rest) signal(p, 'SIGKILL')
  await new Promise((r) => setTimeout(r, 50))
  return rest.filter(alive)
}

/** 자기 자신과 조상(예: worktree 안에서 `minmo rm` 을 실행한 셸)은 정리 대상에서 뺀다 */
export async function selfAndAncestors(): Promise<Set<number>> {
  const out = new Set<number>([process.pid])
  let pid = process.ppid
  for (let i = 0; i < 64 && pid > 1; i++) {
    out.add(pid)
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      // "pid (comm) state ppid ..." — comm 에 공백·괄호가 있을 수 있어 마지막 ')' 뒤를 읽는다
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    } catch {
      const r = await run('ps', ['-o', 'ppid=', '-p', String(pid)])
      pid = Number(r.stdout.trim())
    }
    if (!Number.isInteger(pid)) break
  }
  return out
}

/**
 * Linux 전용: cwd 가 dir(또는 하위)인 같은 사용자 프로세스 — tmux 패널 트리에서 떨어져 나간(setsid·nohup) 프로세스까지 찾는다.
 * /proc 이 없으면(macOS) 빈 목록.
 */
export async function processesInDir(dir: string): Promise<number[]> {
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return []
  }
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  const uid = process.getuid?.()
  const out: number[] = []
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue
    try {
      // 같은 사용자 프로세스만 — root 로 실행해도 다른 사용자 것은 건드리지 않는다
      if (uid !== undefined && (await stat(`/proc/${e}`)).uid !== uid) continue
      const cwd = await readlink(`/proc/${e}/cwd`)
      // 지워진 디렉터리는 " (deleted)" 가 붙는다
      const clean = cwd.replace(/ \(deleted\)$/, '')
      if (clean === dir || clean.startsWith(prefix)) out.push(Number(e))
    } catch {
      // 다른 사용자 프로세스(권한 없음)·이미 끝난 프로세스
    }
  }
  return out
}
