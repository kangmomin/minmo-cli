// 이 기기에만 두는 경로: 기본 폴더(base-dir)와 저장소별 원본 위치(base-repo). config.json 에 저장하고 서버에 올리지 않는다 —
// 경로 설정(worktreePath·mainClonePath)은 모든 기기가 함께 쓰므로, 기기마다 다른 위치는 여기서 정한다.
import { DEFAULT_WORKSPACE_ROOT, checkBaseDir, verifyRepoFolder } from '@minmo/core'

import { CliError, baseRepoKey, baseRepoOf } from '../context'
import type { Ctx } from '../context'
import { parseRepo } from '../refs'
import { updateConfig } from '../store'

/** 값을 지우는 인자 — `minmo config set` 과 같다 */
const UNSET = '-'

export async function baseDirCmd(ctx: Ctx, target?: string): Promise<void> {
  if (target === undefined) {
    ctx.out.log(`현재: ${ctx.config.baseDir ?? `없음 — 경로 설정 그대로(${DEFAULT_WORKSPACE_ROOT})`}`)
    ctx.out.log(`  경로 설정이 ${DEFAULT_WORKSPACE_ROOT} 로 시작할 때 그 부분을 대신합니다. 바꾸기: \`minmo base-dir <경로>\` · 해제: \`minmo base-dir ${UNSET}\``)
    return
  }
  if (target === UNSET) {
    await updateConfig(ctx.paths, ctx.config, (c) => {
      delete c.baseDir
    })
    ctx.out.log('기본 폴더를 해제했습니다 — 경로 설정 그대로 씁니다')
    return
  }
  const error = checkBaseDir(target, ctx.platform)
  if (error) throw new CliError(`${error}: ${target}`, 2)
  const dir = target.trim()
  await updateConfig(ctx.paths, ctx.config, (c) => {
    c.baseDir = dir
  })
  ctx.out.log(`기본 폴더를 ${dir} 로 바꿨습니다 — 다음에 여는 이슈부터 씁니다(이미 만든 worktree 는 옮기지 않습니다)`)
}

export async function baseRepoCmd(ctx: Ctx, repoText: string | undefined, target?: string): Promise<void> {
  if (repoText === undefined) {
    const all = Object.entries(ctx.config.baseRepos ?? {})
    if (all.length === 0) ctx.out.log('원본 위치를 정한 저장소가 없습니다 — `minmo base-repo <owner/repo> <경로>`')
    for (const [repo, path] of all) ctx.out.log(`${repo}\t${path}`)
    return
  }
  const { owner, repo } = parseRepo(repoText)
  if (target === undefined) {
    ctx.out.log(`현재: ${baseRepoOf(ctx.config, owner, repo) ?? '없음 — 설정의 메인 clone 경로에 새로 clone 합니다'}`)
    return
  }
  const key = baseRepoKey(owner, repo)
  if (target === UNSET) {
    await updateConfig(ctx.paths, ctx.config, (c) => {
      if (c.baseRepos) delete c.baseRepos[key]
    })
    ctx.out.log(`${owner}/${repo} 의 원본 위치를 해제했습니다`)
    return
  }
  const res = await verifyRepoFolder(ctx.host, { home: ctx.home, platform: ctx.platform }, target)
  if (!res.ok) throw new CliError(res.error, 2)
  // git 이 돌려준 경로를 저장한다(나중에 git 이 알려 주는 경로와 같은 모양이라 비교가 어긋나지 않는다)
  await updateConfig(ctx.paths, ctx.config, (c) => {
    c.baseRepos = { ...c.baseRepos, [key]: res.top }
  })
  ctx.out.log(`${owner}/${repo} 의 원본 위치: ${res.top} — 새로 clone 하지 않고 이 저장소에서 worktree 를 만듭니다`)
  if (res.origin === null) {
    ctx.out.log('  origin 원격을 확인할 수 없습니다 — fetch·push 가 되지 않을 수 있습니다')
    return
  }
  // 저장은 하고 알리기만 한다(fork·미러를 일부러 쓸 수 있다) — 데스크탑의 기준 저장소 폴더와 같다
  const origin = res.origin.toLowerCase().replace(/\/$/, '').replace(/\.git$/, '')
  if (!origin.endsWith(`/${key}`) && !origin.endsWith(`:${key}`)) ctx.out.log(`  origin 이 다른 저장소입니다: ${res.origin}`)
}

/** doctor 용 한 줄 */
export function baseDirSummary(ctx: Pick<Ctx, 'config'>): string {
  return `기본 폴더: ${ctx.config.baseDir ?? `없음(${DEFAULT_WORKSPACE_ROOT})`}`
}
