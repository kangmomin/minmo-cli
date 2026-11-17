// 이슈 메모 — 데스크탑과 같은 서버의 메모를 $EDITOR 로 편집한다
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { ApiError } from '@minmo/api-client'

import { CliError, requireLogin, serverErrorMessage } from '../context'
import type { Ctx } from '../context'
import { parseRef } from '../refs'

export function editInEditor(initial: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minmo-note-'))
    const file = join(dir, 'note.md')
    try {
      await writeFile(file, initial)
      const editor = env.VISUAL || env.EDITOR
      if (!editor && process.platform === 'win32') {
        // Windows 11 메모장은 창을 넘기고 바로 끝나기도 해서 끝날 때까지 기다릴 수 없다 — 저장했다고 알려 줄 때까지 기다린다
        spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' }).unref()
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        try {
          await rl.question('메모장에서 저장한 뒤 Enter 를 누르세요(다른 편집기는 EDITOR 환경 변수) ')
        } finally {
          rl.close()
        }
        return await readFile(file, 'utf8')
      }
      const cmd = editor || 'vi'
      // "code --wait" 처럼 인자가 붙은 편집기는 셸로 실행하고, 파일 경로는 따옴표로 감싼다
      const r = /\s/.test(cmd)
        ? spawnSync(`${cmd} ${JSON.stringify(file)}`, { stdio: 'inherit', shell: true })
        : spawnSync(cmd, [file], { stdio: 'inherit' })
      if (r.status !== 0) throw new CliError(`편집기가 오류로 끝났습니다: ${cmd}`)
      return await readFile(file, 'utf8')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })()
}

export async function note(ctx: Ctx, refText: string, opts: { edit?: (body: string) => Promise<string> } = {}): Promise<void> {
  await requireLogin(ctx)
  const ref = parseRef(refText)
  const cur = await ctx.api.getNotes(ref.owner, ref.repo, ref.key).catch((e: unknown) => {
    throw new CliError(serverErrorMessage(e, ctx.server))
  })
  const body = await (opts.edit ?? editInEditor)(cur.body)
  if (body === cur.body) return ctx.out.log('변경 없음')
  try {
    await ctx.api.putNotes(ref.owner, ref.repo, ref.key, { body, baseUpdatedAt: cur.updatedAt })
    ctx.out.log('메모를 저장했습니다')
  } catch (e) {
    if (e instanceof ApiError && e.code === 'conflict') {
      // 다른 기기가 먼저 저장 — 내 내용은 잃지 않게 파일로 남긴다
      const keep = join(ctx.paths.configDir, `note-conflict-${ref.owner}-${ref.repo}-${ref.key}-${Date.now()}.md`)
      await writeFile(keep, body)
      throw new CliError(`다른 기기에서 먼저 메모를 바꿨습니다 — 내 내용은 ${keep} 에 저장했습니다. 다시 \`minmo note\` 로 합쳐 주세요`)
    }
    throw new CliError(serverErrorMessage(e, ctx.server))
  }
}
