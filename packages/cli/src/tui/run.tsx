// TUI 실행 루프: 화면 → (tmux·편집기로 넘어감) → 돌아오면 같은 상태로 다시 그린다.
// ink 는 일시 정지가 없어 언마운트 후 터미널을 넘겨주고 다시 render 한다.
import { render } from 'ink'

import { ApiError } from '@minmo/api-client'

import { editInEditor } from '../commands/issues'
import { CliError } from '../context'
import type { Ctx } from '../context'
import { attach, ensureSession, tmuxAvailable } from '../host/tmux'
import { reloadState } from '../store'
import { App } from './App'
import type { ExitResult, Snapshot } from './App'

export async function runTui(ctx: Ctx): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new CliError('TUI 는 터미널에서만 실행할 수 있습니다 — 명령은 `minmo --help`', 2)
  }
  const { login } = await ctx.data.ready()
  let snapshot: Snapshot | undefined
  for (;;) {
    let result: ExitResult = { kind: 'quit' }
    const app = render(<App ctx={ctx} login={login} initial={snapshot} onExit={(r) => (result = r)} />)
    await app.waitUntilExit()
    // render 가 켠 raw 모드를 풀어야 tmux·편집기가 입력을 받는다
    process.stdin.setRawMode?.(false)
    const r = result as ExitResult
    if (r.kind === 'quit') return
    snapshot = r.snapshot
    if (r.kind === 'attach') {
      try {
        if (await tmuxAvailable()) attach(await ensureSession(r.path, r.title))
        else snapshot = { ...snapshot, message: `tmux 가 없어 터미널을 열 수 없습니다 — cd ${r.path}` }
      } catch (e) {
        snapshot = { ...snapshot, message: e instanceof Error ? e.message : String(e) }
      }
    } else {
      const t = r.target
      try {
        const cur = await ctx.api.getNotes(t.owner, t.repo, t.key)
        const body = await editInEditor(cur.body)
        if (body !== cur.body) await ctx.api.putNotes(t.owner, t.repo, t.key, { body, baseUpdatedAt: cur.updatedAt })
        snapshot = { ...snapshot, message: body === cur.body ? '메모 변경 없음' : '메모를 저장했습니다' }
      } catch (e) {
        const msg = e instanceof ApiError && e.code === 'conflict' ? '다른 기기에서 먼저 메모를 바꿨습니다 — `minmo note` 로 다시 편집하세요' : e instanceof Error ? e.message : String(e)
        snapshot = { ...snapshot, message: msg }
      }
    }
    // tmux 안에서 다른 minmo(예: `minmo open`)가 worktree 를 만들었을 수 있다 — 파일의 최신 상태로 다시 그린다
    await reloadState(ctx.paths, ctx.state, ctx.config).catch(() => undefined)
  }
}
