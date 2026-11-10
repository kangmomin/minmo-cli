// 명령어 구성 — 컨텍스트 생성을 주입받아 테스트에서 가짜 서버·호스트로 돌릴 수 있게 한다.
import { Command } from 'commander'

import { doctor, login, logout, revokeSession, sessions } from './commands/account'
import { ls, note, openIssue, rm } from './commands/issues'
import { configGet, configSet, reposAdd, reposAll, reposList, reposRemove } from './commands/settings'
import type { Ctx } from './context'

export type ProgramDeps = {
  createCtx(): Promise<Ctx>
  /** 인자 없이 실행했을 때(TUI) */
  runTui(ctx: Ctx): Promise<void>
  version: string
}

export function buildProgram(deps: ProgramDeps): Command {
  const program = new Command('minmo')
    .description('minmo 원격 관리 — GitHub 이슈 단위 worktree 를 SSH 로 접속한 서버에서 관리합니다')
    .version(deps.version)
    .showHelpAfterError()
  const withCtx =
    <A extends unknown[]>(fn: (ctx: Ctx, ...args: A) => Promise<void>) =>
    async (...args: A) =>
      fn(await deps.createCtx(), ...args)

  program.action(withCtx((ctx) => deps.runTui(ctx)))

  program
    .command('login')
    .argument('<code>', '데스크탑 "원격 CLI 접속"에서 발급한 1회용 코드')
    .description('데스크탑에서 발급한 코드로 로그인')
    .action(withCtx((ctx, code: string) => login(ctx, code)))
  program.command('logout').description('이 기기의 세션을 끊고 로그인 정보를 지웁니다').action(withCtx((ctx) => logout(ctx)))
  program.command('doctor').description('서버(역터널)·로그인·git·gh·tmux 점검').action(withCtx((ctx) => doctor(ctx)))

  program
    .command('ls')
    .argument('[target]', '조직(owner) 또는 저장소(owner/repo) — 없으면 보일 저장소 목록')
    .option('--all', '보일 저장소 선택을 무시하고 전부')
    .option('--json', 'JSON 으로 출력')
    .description('저장소·이슈 목록')
    .action(withCtx((ctx, target: string | undefined, opts: { all?: boolean; json?: boolean }) => ls(ctx, target, opts)))

  program
    .command('open')
    .argument('<issue>', 'owner/repo#번호 또는 owner/repo#etc')
    .option('--no-attach', '터미널(tmux)을 붙이지 않고 경로만 출력')
    .description('이슈 worktree 를 준비하고 tmux 터미널을 붙입니다')
    .action(withCtx((ctx, issue: string, opts: { attach: boolean }) => openIssue(ctx, issue, opts)))

  program
    .command('rm')
    .argument('<issue>', 'owner/repo#번호')
    .option('-y, --yes', '미커밋·미push 가 있어도 묻지 않고 삭제')
    .description('worktree 삭제(그 안의 터미널·프로세스도 정리)')
    .action(withCtx((ctx, issue: string, opts: { yes?: boolean }) => rm(ctx, issue, opts)))

  program
    .command('note')
    .argument('<issue>', 'owner/repo#번호 또는 owner/repo#etc')
    .description('이슈 메모를 $EDITOR 로 편집')
    .action(withCtx((ctx, issue: string) => note(ctx, issue)))

  const repos = program.command('repos').description('보일 저장소(데스크탑과 공유)')
  repos.command('list', { isDefault: true }).description('현재 선택').action(withCtx((ctx) => reposList(ctx)))
  repos
    .command('add')
    .argument('<entries...>', 'owner/repo 또는 owner/*')
    .description('보일 저장소 추가')
    .action(withCtx((ctx, entries: string[]) => reposAdd(ctx, entries)))
  repos
    .command('rm')
    .argument('<entries...>', 'owner/repo 또는 owner/*')
    .description('보일 저장소에서 빼기')
    .action(withCtx((ctx, entries: string[]) => reposRemove(ctx, entries)))
  repos.command('all').description('모든 저장소 표시(선택 해제)').action(withCtx((ctx) => reposAll(ctx)))

  const config = program.command('config').description('설정(전역 → 조직 → 프로젝트 상속, 데스크탑과 공유)')
  config
    .command('get', { isDefault: true })
    .option('--org <owner>', '조직 설정')
    .option('--project <owner/repo>', '프로젝트 설정')
    .option('--effective <owner/repo>', '상속을 합친 최종 값과 출처')
    .option('--json', 'JSON 으로 출력')
    .description('설정 보기')
    .action(withCtx((ctx, opts: { org?: string; project?: string; effective?: string; json?: boolean }) => configGet(ctx, opts)))
  config
    .command('set')
    .argument('<key>', '설정 이름 (branchTemplate, worktreePath, postCreateScriptPosix …)')
    .argument('<value>', '값 · @파일(여러 줄) · -(조직·프로젝트에서 상속으로)')
    .option('--org <owner>', '조직 설정')
    .option('--project <owner/repo>', '프로젝트 설정')
    .description('설정 값 하나 바꾸기')
    .action(withCtx((ctx, key: string, value: string, opts: { org?: string; project?: string }) => configSet(ctx, key, value, opts)))

  const sess = program.command('sessions').description('로그인된 기기(세션)')
  sess
    .command('list', { isDefault: true })
    .option('--json', 'JSON 으로 출력')
    .description('세션 목록')
    .action(withCtx((ctx, opts: { json?: boolean }) => sessions(ctx, opts)))
  sess
    .command('revoke')
    .argument('<id>', '세션 id')
    .description('세션 끊기')
    .action(withCtx((ctx, id: string) => revokeSession(ctx, id)))

  return program
}
