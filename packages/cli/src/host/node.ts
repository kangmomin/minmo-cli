// 원격 CLI 의 호스트 — @minmo/core 의 worktree·GitHub 로직이 쓰는 OS 기능을 Node 로 구현한다.
import type { GhHost, WorktreeHost } from '@minmo/core'

import { copyTree, exists, removeDir } from './fsops'
import { run } from './proc'
import { createScriptHost } from './script'
import { killByCwd } from './tmux'

export type NodeHost = WorktreeHost & GhHost

export function createNodeHost(env: NodeJS.ProcessEnv = process.env): NodeHost {
  // 비대화형으로 — 자격 증명 프롬프트가 뜨면 SSH 세션이 멈춘다
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0' }
  const ghEnv = { ...env, GH_PROMPT_DISABLED: '1' }
  let ghOk: Promise<boolean> | null = null
  return {
    gitRun: (args, opts) => run('git', args, { cwd: opts?.cwd, env: { ...gitEnv, ...opts?.env } }),
    ghRun: (args, opts) => run('gh', args, { cwd: opts?.cwd, env: { ...ghEnv, ...opts?.env }, stdin: opts?.stdin }),
    ghAvailable: () => (ghOk ??= run('gh', ['auth', 'status'], { env: ghEnv }).then((r) => r.code === 0)),
    pathExists: exists,
    removeDir: (p) => removeDir(p),
    copyTree,
    ...createScriptHost(),
    ptyKillByCwd: killByCwd,
  }
}
