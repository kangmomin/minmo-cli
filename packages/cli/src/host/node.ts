// 원격 CLI 의 호스트 — @minmo/core 의 worktree·GitHub 로직이 쓰는 OS 기능을 Node 로 구현한다(Linux·macOS·Windows).
import type { GhHost, WorktreeHost } from '@minmo/core'

import { copyPaths, copyTree, exists, removeDir } from './fsops'
import { run } from './proc'
import { createScriptHost } from './script'
import { killByCwd } from './tmux'
import { killInDir } from './win'
import type { CleanupReport } from './win'

export type NodeHost = WorktreeHost &
  GhHost & {
    /** Windows: 마지막 삭제 전 정리에서 끝낸·남긴 프로세스(명령이 사용자에게 알린다). 가져가면 비운다 */
    takeCleanupReport?(): CleanupReport | null
  }

export function createNodeHost(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeHost {
  // 비대화형으로 — 자격 증명 프롬프트가 뜨면 SSH 세션이 멈춘다
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0' }
  const ghEnv = { ...env, GH_PROMPT_DISABLED: '1' }
  let ghOk: Promise<boolean> | null = null
  let lastCleanup: CleanupReport | null = null
  return {
    gitRun: (args, opts) => run('git', args, { cwd: opts?.cwd, env: { ...gitEnv, ...opts?.env } }),
    ghRun: (args, opts) => run('gh', args, { cwd: opts?.cwd, env: { ...ghEnv, ...opts?.env }, stdin: opts?.stdin }),
    ghAvailable: () => (ghOk ??= run('gh', ['auth', 'status'], { env: ghEnv }).then((r) => r.code === 0)),
    pathExists: exists,
    removeDir: (p) => removeDir(p),
    copyTree,
    copyPaths,
    ...createScriptHost(platform),
    // worktree 를 지우기 전 그 안의 터미널·프로세스 정리 — Windows 는 tmux·/proc 대신 명령줄로 찾는다
    ptyKillByCwd:
      platform === 'win32'
        ? async (p) => {
            lastCleanup = await killInDir(p)
            return lastCleanup.killed.length
          }
        : killByCwd,
    takeCleanupReport: () => {
      const r = lastCleanup
      lastCleanup = null
      return r
    },
  }
}
