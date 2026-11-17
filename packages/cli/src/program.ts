// 명령어 구성 — 컨텍스트 생성을 주입받아 테스트에서 가짜 서버로 돌릴 수 있게 한다.
import { Command } from 'commander'

import { doctor, login, logout, revokeSession, sessions } from './commands/account'
import { note } from './commands/note'
import { configGet, configSet, reposAdd, reposAll, reposList, reposRemove } from './commands/settings'
import type { Ctx } from './context'
import { captureOutput, runInherited, updateCmd } from './update'

export type ProgramDeps = {
  createCtx(): Promise<Ctx>
  version: string
  /** `minmo update` — 테스트에서 바꿔 끼운다(기본: GitHub 에서 확인 후 npm 으로 설치) */
  update?(opts: { check?: boolean }): Promise<void>
}

export function buildProgram(deps: ProgramDeps): Command {
  const program = new Command('minmo')
    .description('minmo 원격 CLI — SSH 역터널로 데스크탑의 minmo 서버에 로그인해 메모·설정·보일 저장소를 다룹니다')
    .version(deps.version)
    .showHelpAfterError()
  const withCtx =
    <A extends unknown[]>(fn: (ctx: Ctx, ...args: A) => Promise<void>) =>
    async (...args: A) =>
      fn(await deps.createCtx(), ...args)

  // 기본 action 은 두지 않는다 — 인자 없이 실행하면 commander 가 도움말을 보여 주고,
  // 없는 명령(예: 이전 버전의 `minmo open`)은 "too many arguments" 대신 "unknown command" 로 안내한다
  program
    .command('login')
    .argument('<code>', '데스크탑 "원격 CLI 접속"에서 발급한 1회용 코드')
    .description('데스크탑에서 발급한 코드로 로그인')
    .action(withCtx((ctx, code: string) => login(ctx, code)))
  program.command('logout').description('이 기기의 세션을 끊고 로그인 정보를 지웁니다').action(withCtx((ctx) => logout(ctx)))
  program.command('doctor').description('서버(역터널)·로그인 점검').action(withCtx((ctx) => doctor(ctx)))
  // 서버·로그인이 필요 없어 컨텍스트를 만들지 않는다
  const update =
    deps.update ??
    ((opts: { check?: boolean }) =>
      updateCmd({ version: deps.version, fetch: (input, init) => globalThis.fetch(input, init), run: runInherited, capture: captureOutput, out: (l) => console.log(l) }, opts))
  program
    .command('update')
    .option('--check', '설치하지 않고 현재·최신 버전만 보기')
    .description('새 버전으로 업데이트(GitHub Packages 의 npm 패키지)')
    .action((opts: { check?: boolean }) => update(opts))

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

  const config = program.command('config').description('설정(전역 → 조직 → 프로젝트 상속 · 데스크탑과 공유)')
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
    .argument('<value>', '값 · @파일(여러 줄) · -(상속으로)')
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
