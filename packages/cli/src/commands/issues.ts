// 트리 조회·이슈 열기·worktree 삭제·메모
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm as rmFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { ApiError } from '@minmo/api-client'
import { isOwnerVisible, isRepoVisible, worktreeId } from '@minmo/core'
import type { GitHubOwner, IssueTarget, RepoSelection, SetupLogEvent } from '@minmo/core'

import { CliError, requireLogin, serverErrorMessage, toCliError } from '../context'
import type { Ctx } from '../context'
import { NOTES_SERVER_ONLY } from '../errors'
import { openTerminal, terminalAvailable } from '../host/terminal'
import { parseRef, resolveTarget } from '../refs'

/** 보일 저장소 선택(모드에 따라 서버 값 또는 로컬 값·서버 사본) */
export async function loadSelection(ctx: Ctx): Promise<RepoSelection> {
  return (await ctx.data.getSelection()).repos
}

const hasWorktree = (ctx: Ctx, owner: string, repo?: string) => {
  const prefix = (repo === undefined ? `${owner}/` : worktreeId(owner, repo, '')).toLowerCase()
  return Object.keys(ctx.state.worktrees).some((id) => id.toLowerCase().startsWith(prefix))
}

export type LsRow =
  | { kind: 'repo'; owner: string; repo: string; hidden: boolean; worktrees: number }
  | { kind: 'issue'; owner: string; repo: string; key: string; number: number | null; title: string; state: 'open' | 'closed'; worktree: string | null }

export async function listRepoRows(ctx: Ctx, owners: GitHubOwner[], sel: RepoSelection, all: boolean): Promise<LsRow[]> {
  const rows: LsRow[] = []
  for (const o of owners) {
    if (!all && !isOwnerVisible(sel, o.login) && !hasWorktree(ctx, o.login)) continue
    for (const r of await ctx.github.listRepos(o)) {
      const visible = isRepoVisible(sel, r.owner, r.name)
      if (!all && !visible && !hasWorktree(ctx, r.owner, r.name)) continue
      const prefix = worktreeId(r.owner, r.name, '')
      const worktrees = Object.keys(ctx.state.worktrees).filter((id) => id.startsWith(prefix)).length
      rows.push({ kind: 'repo', owner: r.owner, repo: r.name, hidden: !visible, worktrees })
    }
  }
  return rows
}

/** ★기타 + open 이슈 + closed 중 이 기기에 worktree 가 있는 것(데스크탑 트리와 같은 규칙) */
export async function listIssueRows(ctx: Ctx, owner: string, repo: string): Promise<LsRow[]> {
  const r = await ctx.github.getRepo(owner, repo)
  const prefix = worktreeId(r.owner, r.name, '')
  const local = Object.keys(ctx.state.worktrees)
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter((n) => Number.isInteger(n) && n > 0)
  const issues = await ctx.github.listIssues(r.owner, r.name, { ensureNumbers: local })
  const wt = (key: string) => ctx.state.worktrees[worktreeId(r.owner, r.name, key)]?.path ?? null
  const rows: LsRow[] = [{ kind: 'issue', owner: r.owner, repo: r.name, key: 'etc', number: null, title: '기타', state: 'open', worktree: wt('etc') }]
  for (const i of issues.sort((a, b) => b.number - a.number)) {
    const path = wt(String(i.number))
    if (i.state === 'closed' && path === null) continue
    rows.push({ kind: 'issue', owner: r.owner, repo: r.name, key: String(i.number), number: i.number, title: i.title, state: i.state, worktree: path })
  }
  return rows
}

export async function ls(ctx: Ctx, target: string | undefined, opts: { json?: boolean; all?: boolean }): Promise<void> {
  await ctx.data.ready()
  let rows: LsRow[]
  if (target?.includes('/')) {
    const [owner, repo] = target.split('/')
    rows = await listIssueRows(ctx, owner, repo)
  } else {
    const sel = opts.all ? null : await loadSelection(ctx)
    const owners = (await ctx.github.listOwners()).filter((o) => target === undefined || o.login.toLowerCase() === target.toLowerCase())
    if (target !== undefined && owners.length === 0) throw new CliError(`조직(또는 계정)을 찾을 수 없습니다: ${target}`)
    rows = await listRepoRows(ctx, owners, sel, !!opts.all)
  }
  if (opts.json) return ctx.out.log(JSON.stringify(rows, null, 2))
  for (const r of rows) {
    if (r.kind === 'repo') ctx.out.log(`${r.owner}/${r.repo}${r.worktrees > 0 ? `  ●${r.worktrees}` : ''}${r.hidden ? '  (숨김)' : ''}`)
    else ctx.out.log(`${r.worktree ? '●' : ' '} #${r.key.padEnd(6)} ${r.state === 'closed' ? '[closed] ' : ''}${r.title}${r.worktree ? `  → ${r.worktree}` : ''}`)
  }
  if (rows.length === 0) ctx.out.log('(표시할 항목 없음 — `minmo repos` 로 보일 저장소를 고르세요)')
}

function printLog(ctx: Ctx) {
  return (e: SetupLogEvent) => {
    if (e.status === 'log') return ctx.out.log(`  ${e.message ?? ''}`)
    const mark = e.status === 'ok' ? '✓' : e.status === 'error' ? '✗' : e.status === 'cancelled' ? '-' : '…'
    ctx.out.log(`${mark} ${e.step}${e.message ? ` ${e.message}` : ''}`)
  }
}

export async function openIssue(ctx: Ctx, refText: string, opts: { attach: boolean }): Promise<void> {
  await ctx.data.ready()
  const target = await resolveTarget(ctx.github, parseRef(refText))
  ctx.onLog(printLog(ctx))
  let res
  try {
    res = await ctx.worktree.openIssue(target)
  } catch (e) {
    throw toCliError(e, ctx.server)
  } finally {
    ctx.onLog(null)
  }
  ctx.out.log(`${res.created ? '준비됨' : '이미 있음'}: ${res.branch}  ${res.path}`)
  if (res.pathChanged) ctx.out.log('  (설정의 worktree 경로가 바뀌었지만 기존 위치를 그대로 씁니다)')
  if (res.script.status === 'failed') ctx.out.log(`  생성 후 스크립트 실패(종료 코드 ${res.script.exitCode ?? '?'}) — worktree 는 그대로입니다`)
  if (!opts.attach) return
  if (!(await terminalAvailable())) {
    ctx.out.log(`tmux 가 없어 터미널을 열 수 없습니다 — cd ${res.path}`)
    return
  }
  await openTerminal(res.path, `${target.repo}#${target.key}`)
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
  } finally {
    rl.close()
  }
}

export async function removeWorktree(ctx: Ctx, target: IssueTarget, opts: { yes?: boolean; ask?: (q: string) => Promise<boolean> }): Promise<void> {
  if (target.key === 'etc') throw new CliError('★기타 worktree 는 삭제하지 않습니다')
  if (!ctx.state.worktrees[worktreeId(target.owner, target.repo, target.key)]) {
    throw new CliError(`이 기기에 worktree 가 없습니다: ${target.owner}/${target.repo}#${target.key}`)
  }
  // 호스트·git 오류(예: 지울 worktree 의 터미널 안에서 실행)는 스택 없이 안내만
  const del = (confirmed: boolean) =>
    ctx.worktree.deleteWorktree(target, { confirmed }).catch((e: unknown) => {
      throw toCliError(e, ctx.server)
    })
  let res = await del(!!opts.yes)
  if (res.status === 'needs_confirmation') {
    const what = [
      res.uncommitted === null ? '미커밋 변경(확인 실패)' : res.uncommitted > 0 ? `미커밋 변경 ${res.uncommitted}개` : '',
      res.unpushed === null ? '미push 커밋(확인 실패)' : res.unpushed > 0 ? `미push 커밋 ${res.unpushed}개` : '',
    ]
      .filter(Boolean)
      .join(', ')
    const ok = await (opts.ask ?? confirm)(`${what} 이(가) 있습니다. 그래도 삭제할까요?`)
    if (!ok) throw new CliError('삭제를 취소했습니다(확인 없이 지우려면 --yes)', 1)
    res = await del(true)
  }
  if (res.status === 'deleted') ctx.out.log(`삭제했습니다: ${target.owner}/${target.repo}#${target.key} (터미널·프로세스 정리 포함)`)
}

export async function rm(ctx: Ctx, refText: string, opts: { yes?: boolean }): Promise<void> {
  await ctx.data.ready()
  const ref = parseRef(refText)
  // GitHub 이슈가 지워졌어도 로컬 worktree 는 지울 수 있게 — 저장된 대소문자로 찾는다
  const id = Object.keys(ctx.state.worktrees).find((k) => k.toLowerCase() === worktreeId(ref.owner, ref.repo, ref.key).toLowerCase())
  const [owner, rest] = (id ?? worktreeId(ref.owner, ref.repo, ref.key)).split('/')
  const repo = rest.split('#')[0]
  await removeWorktree(ctx, { owner, repo, key: ref.key, number: ref.key === 'etc' ? null : Number(ref.key), title: '' }, opts)
}

export function editInEditor(initial: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minmo-note-'))
    const file = join(dir, 'note.md')
    try {
      await writeFile(file, initial)
      const editor = env.VISUAL || env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi')
      // "code --wait" 처럼 인자가 붙은 편집기는 셸로 실행하고, 파일 경로는 따옴표로 감싼다
      const r = /\s/.test(editor)
        ? spawnSync(`${editor} ${JSON.stringify(file)}`, { stdio: 'inherit', shell: true })
        : spawnSync(editor, [file], { stdio: 'inherit' })
      if (r.status !== 0) throw new CliError(`편집기가 오류로 끝났습니다: ${editor}`)
      return await readFile(file, 'utf8')
    } finally {
      await rmFile(dir, { recursive: true, force: true })
    }
  })()
}

export async function note(ctx: Ctx, refText: string, opts: { edit?: (body: string) => Promise<string> } = {}): Promise<void> {
  if (ctx.mode === 'local') throw new CliError(NOTES_SERVER_ONLY)
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
