// worktree 터미널 방식: shell(일반 셸, 기본) ↔ tmux(전용 tmux 세션). 이 기기의 config.json 에만 저장한다.
import { CliError } from '../context'
import type { Ctx } from '../context'
import { terminalLabel } from '../host/terminal'
import { tmuxAvailable } from '../host/tmux'
import { updateConfig } from '../store'

export async function terminalCmd(ctx: Ctx, target?: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (target === undefined) {
    ctx.out.log(`현재: ${terminalLabel(ctx.config.terminal, platform)}`)
    if (platform === 'win32') ctx.out.log('  Windows 는 항상 PowerShell 을 씁니다(접속이 끊겨도 유지하려면 WSL 의 Linux 버전에서 tmux)')
    else if (ctx.config.terminal === 'tmux') ctx.out.log('  일반 셸로: `minmo terminal shell`')
    else ctx.out.log('  접속이 끊겨도 터미널을 유지하려면: `minmo terminal tmux`')
    return
  }
  if (target !== 'shell' && target !== 'tmux') throw new CliError(`터미널은 shell 또는 tmux 입니다: ${target}`, 2)
  if (target === 'tmux' && platform === 'win32') throw new CliError('Windows 에서는 tmux 를 쓸 수 없습니다 — 터미널은 항상 PowerShell 입니다')

  await updateConfig(ctx.paths, ctx.config, (c) => {
    c.terminal = target
  })
  ctx.out.log(platform === 'win32' ? '저장했습니다 — Windows 는 항상 PowerShell 을 씁니다' : `터미널을 ${terminalLabel(target, platform)} 로 바꿨습니다`)
  if (target === 'tmux' && !(await tmuxAvailable())) ctx.out.log('  tmux 가 없습니다 — 설치하기 전에는 터미널을 열 수 없습니다')
  // 전에 만든 tmux 세션은 그대로 남는다 — worktree 를 지울 때 함께 정리된다
  if (target === 'shell' && platform !== 'win32') ctx.out.log('  남아 있는 tmux 세션은 worktree 를 지울 때 정리됩니다(다시 붙으려면 `minmo terminal tmux`)')
}
