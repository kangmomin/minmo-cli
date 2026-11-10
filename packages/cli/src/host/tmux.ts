// worktree 터미널 = 전용 tmux 서버(-L minmo)의 세션. 사용자 기본 tmux 와 섞이지 않고,
// 세션마다 @minmo_worktree 태그를 달아 worktree 삭제 때 정확히 찾는다(사용자가 cd 로 옮겨도).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { normalize } from 'node:path'

import { descendants, processTree, processesInDir, run, selfAndAncestors, terminate } from './proc'

export const TMUX_SOCKET = 'minmo'

const tmux = (args: string[]) => run('tmux', ['-L', TMUX_SOCKET, ...args])

/** 비교·이름용 경로 — 끝의 구분자를 떼어 `/a/b` 와 `/a/b/` 를 같게 본다 */
const canon = (p: string) => normalize(p).replace(/(.)[\\/]+$/, '$1')

export function sessionName(worktreePath: string): string {
  return `minmo-${createHash('sha1').update(canon(worktreePath)).digest('hex').slice(0, 10)}`
}

export async function tmuxAvailable(): Promise<boolean> {
  return (await run('tmux', ['-V'])).code === 0
}

/** 세션이 없으면 worktree 를 cwd 로 만든다. 이름을 돌려준다 */
export async function ensureSession(worktreePath: string, title: string): Promise<string> {
  const name = sessionName(worktreePath)
  if ((await tmux(['has-session', '-t', `=${name}`])).code !== 0) {
    const r = await tmux(['new-session', '-d', '-s', name, '-c', worktreePath, '-n', title.slice(0, 40)])
    if (r.code !== 0) throw new Error(`tmux 세션을 만들 수 없습니다: ${r.stderr.trim()}`)
    await tmux(['set-option', '-t', name, '@minmo_worktree', canon(worktreePath)])
  }
  return name
}

/**
 * 터미널을 붙인다(현재 터미널을 넘겨주고 detach 하면 돌아온다).
 * 이미 minmo tmux 안이면 switch-client, 다른 tmux 안이면 TMUX 를 비워 중첩한다.
 */
export function attach(name: string, env: NodeJS.ProcessEnv = process.env): number {
  const inMinmo = (env.TMUX ?? '').includes(`/${TMUX_SOCKET},`)
  const args = ['-L', TMUX_SOCKET, inMinmo ? 'switch-client' : 'attach-session', '-t', `=${name}`]
  const r = spawnSync('tmux', args, { stdio: 'inherit', env: inMinmo ? env : { ...env, TMUX: '' } })
  return r.status ?? 1
}

type Session = { name: string; worktree: string }

export async function listSessions(): Promise<Session[]> {
  const r = await tmux(['list-sessions', '-F', '#{session_name}\t#{@minmo_worktree}'])
  if (r.code !== 0) return []
  return r.stdout
    .split('\n')
    .map((l) => l.split('\t'))
    .filter(([name, wt]) => name && wt)
    .map(([name, wt]) => ({ name, worktree: wt }))
}

const inside = (child: string, parent: string) => {
  const c = canon(child)
  const p = canon(parent)
  return c === p || c.startsWith(`${p}/`)
}

/**
 * worktree(또는 하위)에서 돌던 터미널과 그 안의 모든 프로세스를 끝낸다. 끝낸 세션 수를 돌려준다.
 * 1) 태그가 맞는 tmux 세션의 패널 프로세스 + 자손 트리 → SIGTERM, 3초 뒤 SIGKILL → kill-session
 * 2) Linux 는 cwd 가 worktree 안인 같은 사용자 프로세스(setsid·nohup 으로 트리에서 떨어진 에이전트 등)도 정리 — 자신·조상은 제외
 */
export async function killByCwd(path: string): Promise<number> {
  const sessions = (await listSessions()).filter((s) => inside(s.worktree, path))
  const roots: number[] = []
  for (const s of sessions) {
    const r = await tmux(['list-panes', '-s', '-t', `=${s.name}`, '-F', '#{pane_pid}'])
    roots.push(...r.stdout.split('\n').map(Number).filter((n) => Number.isInteger(n) && n > 1))
  }
  const keep = await selfAndAncestors()
  const tree = await processTree()
  const targets = new Set(descendants(roots, tree).filter((p) => !keep.has(p)))
  for (const p of await processesInDir(canon(path))) if (!keep.has(p)) targets.add(p)
  await terminate([...targets])
  for (const s of sessions) await tmux(['kill-session', '-t', `=${s.name}`])
  return sessions.length
}
