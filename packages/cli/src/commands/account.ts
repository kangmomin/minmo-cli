// 로그인·로그아웃·세션·진단
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'

import { ApiError } from '@minmo/api-client'

import { CliError, GITHUB_AUTH_REQUIRED, requireLogin, serverErrorMessage } from '../context'
import type { Ctx } from '../context'
import { run } from '../host/proc'
import { tmuxAvailable } from '../host/tmux'
import { WINDOWS_SERVER_HINT, describeServer } from '../server'
import { clearCredentials, saveCredentials } from '../store'
import { MODE_LABEL, describeCopy } from './mode'

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
  const me = await ctx.api.me({ token: session }).catch(async (e: unknown) => {
    // 방금 만든 세션이 서버에 남지 않게 정리한다
    await ctx.api.logout({ token: session }).catch(() => undefined)
    throw new CliError(serverErrorMessage(e, ctx.server))
  })
  await saveCredentials(ctx.paths, { session, login: me.githubLogin, savedAt: new Date().toISOString() })
  ctx.out.log(`로그인했습니다: ${me.githubLogin} (이 기기: ${hostname()})`)
  if (ctx.mode === 'local') ctx.out.log('  지금은 로컬 모드입니다 — 서버 값을 쓰려면 `minmo mode server`')
}

export async function logout(ctx: Ctx): Promise<void> {
  let revoked = !ctx.creds?.session
  if (ctx.creds?.session) revoked = await ctx.api.logout().then(
    () => true,
    () => false,
  )
  await clearCredentials(ctx.paths)
  ctx.out.log('로그아웃했습니다')
  // 서버에 닿지 못하면 세션이 30일 동안 살아 있다 — 데스크탑에서 끊도록 안내
  if (!revoked) ctx.out.log('  서버에 연결하지 못해 세션은 남아 있습니다 — 데스크탑 "원격 CLI 접속"의 로그인된 기기에서 끊으세요')
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

type Add = (ok: boolean, label: string, hint?: string) => void

/** 서버 모드 점검: 역터널 소켓·서버 응답·로그인. 서버가 응답하면 true */
async function checkServer(ctx: Ctx, add: Add): Promise<boolean> {
  if (ctx.server.kind === 'unset') {
    // Windows: 주소가 없으면 연결해 볼 곳도 없다
    add(false, 'MINMO_SERVER 미설정', WINDOWS_SERVER_HINT)
    return false
  }
  if (ctx.server.kind === 'socket' && !existsSync(ctx.server.path)) {
    add(false, `역터널 소켓 없음: ${ctx.server.path}`, 'PC 의 ~/.ssh/config 에 RemoteForward <이 경로> 127.0.0.1:8787 을 넣고 다시 접속하세요(원격 sshd 가 AllowStreamLocalForwarding 을 허용해야 함)')
  } else {
    add(true, `서버 경로: ${describeServer(ctx.server)}`)
  }
  const health = await ctx.api.healthz().then(
    () => true,
    () => false,
  )
  const socket = ctx.server.kind === 'socket' ? ctx.server.path : null
  const stale = !health && socket !== null && existsSync(socket)
  add(
    health,
    health ? '서버 응답' : stale ? '소켓은 있지만 응답 없음 — 이전 접속의 소켓이 남았을 수 있습니다' : '서버에 연결할 수 없음',
    health
      ? undefined
      : stale
        ? `rm ${socket} 후 다시 접속하세요(원격 sshd_config 에 StreamLocalBindUnlink yes 가 있으면 자동으로 바뀝니다). PC 의 minmo 서버가 켜져 있는지도 확인하세요`
        : 'SSH 역터널·PC 의 minmo 서버 실행 여부를 확인하세요',
  )
  if (!ctx.creds?.session) add(false, '로그인 안 됨', '`minmo login <코드>`')
  else if (health) {
    try {
      const me = await requireLogin(ctx)
      add(true, `로그인: ${me.githubLogin}`)
    } catch (e) {
      add(false, e instanceof Error ? e.message : String(e))
    }
  }
  return health
}

/** 원격 사용에 필요한 것을 점검한다 — 하나라도 실패하면 종료 코드 1 */
export async function doctor(ctx: Ctx): Promise<void> {
  const checks: Check[] = []
  const add: Add = (ok, label, hint) => checks.push({ ok, label, hint })

  add(true, `모드: ${MODE_LABEL[ctx.mode]}${ctx.mode === 'local' ? ` — ${describeCopy(ctx)}` : ''}`)
  // 로컬 모드는 서버를 쓰지 않는다 — 터널·로그인 점검을 건너뛴다
  const health = ctx.mode === 'server' ? await checkServer(ctx, add) : false

  const git = await run('git', ['--version'])
  const ver = /(\d+)\.(\d+)/.exec(git.stdout)
  const gitOk = git.code === 0 && !!ver && (Number(ver[1]) > 2 || (Number(ver[1]) === 2 && Number(ver[2]) >= 31))
  add(gitOk, git.code === 0 ? `git ${git.stdout.trim().replace(/^git version /, '')}` : 'git 없음', gitOk ? undefined : 'git 2.31 이상이 필요합니다(worktree·부분 clone)')

  const gh = await ctx.host.ghAvailable()
  const envToken = !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN)
  if (ctx.mode === 'local') {
    // 서버 토큰이 없으므로 gh 또는 환경 변수 토큰이 꼭 있어야 한다
    add(gh || envToken, gh ? 'gh 로그인됨' : envToken ? 'GitHub 토큰: 환경 변수' : 'GitHub 인증 없음', GITHUB_AUTH_REQUIRED)
  } else {
    add(
      gh || envToken || health,
      gh ? 'gh 로그인됨' : envToken ? 'GitHub 토큰: 환경 변수' : 'gh 미사용 — 서버 토큰으로 REST 사용',
      gh ? undefined : 'private 저장소 clone 에는 `gh auth login` 후 `gh auth setup-git` 을 권장합니다',
    )
  }

  if (process.platform === 'win32') {
    // 터미널·생성 후 스크립트가 PowerShell 을 쓴다(세션 유지는 없다 — 필요하면 WSL 의 Linux 버전)
    const ps = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'])).stdout.trim()
    add(ps !== '', ps ? `PowerShell ${ps}` : 'PowerShell 없음', ps ? undefined : '터미널(`minmo open`, TUI 의 t)과 생성 후 스크립트에 PowerShell 이 필요합니다')
  } else {
    const tmux = await tmuxAvailable()
    add(tmux, tmux ? 'tmux 있음' : 'tmux 없음', tmux ? undefined : '터미널(`minmo open`, TUI 의 t)에 tmux 가 필요합니다')
  }

  for (const c of checks) {
    ctx.out.log(`${c.ok ? '✓' : '✗'} ${c.label}`)
    if (!c.ok && c.hint) ctx.out.log(`    → ${c.hint}`)
  }
  if (checks.some((c) => !c.ok)) throw new CliError('점검에 실패한 항목이 있습니다', 1)
}
