// 로그인·로그아웃·세션·진단
import { hostname } from 'node:os'

import { ApiError } from '@minmo/api-client'

import { CliError, requireLogin, serverErrorMessage } from '../context'
import type { Ctx } from '../context'
import { run } from '../host/proc'
import { tmuxAvailable } from '../host/tmux'
import { describeServer } from '../server'
import { clearCredentials, saveCredentials } from '../store'

export async function login(ctx: Ctx, code: string): Promise<void> {
  let session: string
  try {
    ;({ session } = await ctx.api.exchangeCliCode(code, hostname()))
  } catch (e) {
    if (e instanceof ApiError && e.code === 'invalid_cli_code') {
      throw new CliError('코드가 맞지 않거나 만료됐습니다 — 데스크탑에서 새 코드를 발급하세요(10분, 1회용)')
    }
    throw new CliError(serverErrorMessage(e, ctx.server))
  }
  const me = await ctx.api.me({ token: session }).catch((e: unknown) => {
    throw new CliError(serverErrorMessage(e, ctx.server))
  })
  await saveCredentials(ctx.paths, { session, login: me.githubLogin, savedAt: new Date().toISOString() })
  ctx.out.log(`로그인했습니다: ${me.githubLogin} (이 기기: ${hostname()})`)
}

export async function logout(ctx: Ctx): Promise<void> {
  if (ctx.creds?.session) await ctx.api.logout().catch(() => undefined)
  await clearCredentials(ctx.paths)
  ctx.out.log('로그아웃했습니다')
}

export async function sessions(ctx: Ctx, opts: { json?: boolean }): Promise<void> {
  await requireLogin(ctx)
  const { sessions } = await ctx.api.listSessions()
  if (opts.json) return ctx.out.log(JSON.stringify(sessions, null, 2))
  for (const s of sessions) {
    const kind = s.kind === 'cli' ? 'CLI    ' : '데스크탑'
    const used = s.lastUsedAt ? `최근 ${s.lastUsedAt}` : '사용 기록 없음'
    ctx.out.log(`${s.current ? '*' : ' '} ${kind}  ${(s.label ?? '-').padEnd(20)}  ${used}  ${s.id}`)
  }
}

export async function revokeSession(ctx: Ctx, id: string): Promise<void> {
  await requireLogin(ctx)
  try {
    await ctx.api.revokeSession(id)
  } catch (e) {
    if (e instanceof ApiError && e.code === 'not_found') throw new CliError(`세션이 없습니다: ${id}`)
    throw new CliError(serverErrorMessage(e, ctx.server))
  }
  ctx.out.log(`세션을 끊었습니다: ${id}`)
}

type Check = { ok: boolean; label: string; hint?: string }

/** 원격 사용에 필요한 것을 점검한다 — 하나라도 실패하면 종료 코드 1 */
export async function doctor(ctx: Ctx): Promise<void> {
  const checks: Check[] = []
  const add = (ok: boolean, label: string, hint?: string) => checks.push({ ok, label, hint })

  add(true, `서버 경로: ${describeServer(ctx.server)}`)
  if (ctx.server.kind === 'tcp' && !process.env.MINMO_SERVER) {
    add(false, `역터널 소켓 없음: ${ctx.paths.socket}`, 'PC 의 ~/.ssh/config 에 RemoteForward <이 경로> 127.0.0.1:8787 을 넣고 다시 접속하세요(원격 sshd 가 AllowStreamLocalForwarding 을 허용해야 함)')
  }
  const health = await ctx.api.healthz().then(
    () => true,
    () => false,
  )
  add(health, health ? '서버 응답' : '서버에 연결할 수 없음', health ? undefined : 'SSH 역터널·PC 의 minmo 서버 실행 여부를 확인하세요')
  if (!ctx.creds?.session) add(false, '로그인 안 됨', '`minmo login <코드>`')
  else if (health) {
    try {
      const me = await requireLogin(ctx)
      add(true, `로그인: ${me.githubLogin}`)
    } catch (e) {
      add(false, e instanceof Error ? e.message : String(e))
    }
  }

  const git = await run('git', ['--version'])
  const ver = /(\d+)\.(\d+)/.exec(git.stdout)
  const gitOk = git.code === 0 && !!ver && (Number(ver[1]) > 2 || (Number(ver[1]) === 2 && Number(ver[2]) >= 31))
  add(gitOk, git.code === 0 ? `git ${git.stdout.trim().replace(/^git version /, '')}` : 'git 없음', gitOk ? undefined : 'git 2.31 이상이 필요합니다(worktree·부분 clone)')

  const gh = await ctx.host.ghAvailable()
  const envToken = !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN)
  add(
    gh || envToken || health,
    gh ? 'gh 로그인됨' : envToken ? 'GitHub 토큰: 환경 변수' : 'gh 미사용 — 서버 토큰으로 REST 사용',
    gh ? undefined : 'private 저장소 clone 에는 `gh auth login` 후 `gh auth setup-git` 을 권장합니다',
  )

  const tmux = await tmuxAvailable()
  add(tmux, tmux ? 'tmux 있음' : 'tmux 없음', tmux ? undefined : '터미널(`minmo open`, TUI 의 t)에 tmux 가 필요합니다')

  for (const c of checks) {
    ctx.out.log(`${c.ok ? '✓' : '✗'} ${c.label}`)
    if (!c.ok && c.hint) ctx.out.log(`    → ${c.hint}`)
  }
  if (checks.some((c) => !c.ok)) throw new CliError('점검에 실패한 항목이 있습니다', 1)
}
