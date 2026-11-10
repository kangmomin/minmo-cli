// 변경 탭 git·PR 동작 (F-05) — 근거: AC-09, AC-10, AC-11, EC-11, EC-12, EC-13, EC-14, A-07(draft 기본)
import { describe, expect, it } from 'vitest'

import { GitHubError } from '@minmo/core'
import type { CmdResult, RunOptions } from '../../lib/tauri'
import { createFakeGitHub, createFakeTauri, fail, ok } from '../../test/fakes'
import { GitError, buildPrDraft, createGitOps, parsePorcelainV2 } from './useGit'

const CWD = '/home/u/minmo-workspaces/MyOrg/Repo-A/issue--42-add-login'
const BRANCH = 'issue/42-add-login'
const H = 'abc1234def5678abc1234def5678abc1234def56'

const strip = (args: string[]) => {
  const a = [...args]
  const i = a.indexOf('-C')
  if (i >= 0) a.splice(i, 2)
  return a
}

function setup(git: (a: string[], opts?: RunOptions) => CmdResult | Promise<CmdResult> = () => ok(), gh = {}) {
  const fake = createFakeTauri({ gitRun: async (args, opts) => git(strip(args), opts) })
  const github = createFakeGitHub(gh)
  const ops = createGitOps({ tauri: fake.tauri, github })
  const cmds = () => fake.tauri.gitRun.mock.calls.map(([a]) => strip(a))
  return { ops, tauri: fake.tauri, github, cmds }
}

describe('AC-09 status --porcelain=v2 파싱', () => {
  it('헤더(#)는 무시하고 변경·추가·rename·untracked 를 모두 파일 목록으로', () => {
    const out = [
      '# branch.oid ' + H,
      '# branch.head issue/42-add-login',
      `1 .M N... 100644 100644 100644 ${H} ${H} src/a.ts`,
      `1 A. N... 000000 100644 100644 ${H} ${H} src/b.ts`,
      `2 R. N... 100644 100644 100644 ${H} ${H} R100 src/new name.ts\tsrc/old.ts`,
      '? notes.txt',
      '',
    ].join('\n')
    const files = parsePorcelainV2(out)
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/new name.ts', 'notes.txt'])
    expect(files[0]).toMatchObject({ staged: false, unstaged: true, untracked: false })
    expect(files[1]).toMatchObject({ staged: true, unstaged: false })
    expect(files[2]).toMatchObject({ origPath: 'src/old.ts', staged: true })
    expect(files[3]).toMatchObject({ untracked: true })
  })

  it('빈 출력 → 빈 목록', () => {
    expect(parsePorcelainV2('')).toEqual([])
  })

  it('status() 는 worktree cwd 에서 porcelain=v2 로 조회', async () => {
    const t = setup((a) => (a[0] === 'status' ? ok(`1 .M N... 100644 100644 100644 ${H} ${H} src/a.ts\n`) : ok()))
    const files = await t.ops.status(CWD)
    expect(files.map((f) => f.path)).toEqual(['src/a.ts'])
    const call = t.tauri.gitRun.mock.calls[0]
    expect(strip(call[0])).toContain('--porcelain=v2')
    expect(call[1]?.cwd ?? call[0][call[0].indexOf('-C') + 1]).toBe(CWD)
  })
})

describe('AC-09 선택 파일만 스테이징·커밋, 커밋 해시 반환', () => {
  it('선택 파일만 add 하고 해당 경로로 한정해 커밋, 해시 반환', async () => {
    const t = setup((a) => {
      if (a[0] === 'commit') return ok(`[${BRANCH} abc1234] feat: login\n 1 file changed`)
      if (a[0] === 'rev-parse') return ok(H + '\n')
      return ok()
    })
    const res = await t.ops.commit(CWD, ['src/a.ts'], 'feat: login')
    expect(res.hash).toMatch(/^abc1234/)

    const adds = t.cmds().filter((a) => a[0] === 'add')
    expect(adds.flat()).toContain('src/a.ts')
    expect(adds.flat()).not.toContain('src/b.ts')
    expect(adds.flat()).not.toContain('-A')
    expect(adds.flat()).not.toContain('.')

    const commit = t.cmds().find((a) => a[0] === 'commit')!
    expect(commit).toContain('feat: login')
    expect(commit).not.toContain('-a')
    expect(commit).not.toContain('--all')
    // 이미 인덱스에 올라간 다른 파일이 섞이지 않도록 pathspec 으로 한정
    expect(commit).toContain('src/a.ts')
  })

  it('선택 파일이 없으면 커밋하지 않는다', async () => {
    const t = setup()
    await expect(t.ops.commit(CWD, [], 'msg')).rejects.toMatchObject({ code: 'nothing_selected' })
    expect(t.cmds().some((a) => a[0] === 'commit')).toBe(false)
  })
})

describe('AC-10 push / EC-11 / EC-12', () => {
  it('AC-10 git push -u origin <branch>, force 없음', async () => {
    const t = setup()
    await t.ops.push(CWD, BRANCH)
    const push = t.cmds().filter((a) => a[0] === 'push')
    expect(push).toHaveLength(1)
    expect(push[0]).toEqual(expect.arrayContaining(['-u', 'origin', BRANCH]))
    expect(push[0].some((x) => /^(-f|--force.*)$/.test(x) || x.startsWith('+'))).toBe(false)
  })

  it('EC-12 non-fast-forward 거절 → push_rejected + stderr 전문, 재시도·force 없음', async () => {
    const stderr = [
      `To https://github.com/MyOrg/Repo-A.git`,
      ` ! [rejected]        ${BRANCH} -> ${BRANCH} (non-fast-forward)`,
      `error: failed to push some refs to 'https://github.com/MyOrg/Repo-A.git'`,
      `hint: Updates were rejected because the tip of your current branch is behind`,
    ].join('\n')
    const t = setup((a) => (a[0] === 'push' ? fail(stderr, 1) : ok()))
    const err = (await t.ops.push(CWD, BRANCH).catch((e: unknown) => e)) as GitError
    expect(err).toBeInstanceOf(GitError)
    expect(err.code).toBe('push_rejected')
    expect(err.stderr).toBe(stderr)
    const push = t.cmds().filter((a) => a[0] === 'push')
    expect(push).toHaveLength(1)
  })

  it('EC-11 push 권한 없음(403) → permission_denied + stderr', async () => {
    const stderr = [
      'remote: Permission to MyOrg/Repo-A.git denied to someone.',
      "fatal: unable to access 'https://github.com/MyOrg/Repo-A.git/': The requested URL returned error: 403",
    ].join('\n')
    const t = setup((a) => (a[0] === 'push' ? fail(stderr, 128) : ok()))
    const err = (await t.ops.push(CWD, BRANCH).catch((e: unknown) => e)) as GitError
    expect(err).toBeInstanceOf(GitError)
    expect(err.code).toBe('permission_denied')
    expect(err.stderr).toBe(stderr)
  })

  it('EC-11 PR 생성 403 → permission_denied (fork 제안 없음)', async () => {
    const t = setup(undefined, {
      createPr: async () => {
        throw new GitHubError('forbidden', { status: 403, message: 'Resource not accessible by integration' })
      },
    })
    const err = await t.ops
      .createOrOpenPr({ owner: 'MyOrg', repo: 'Repo-A', branch: BRANCH, issue: { number: 42, title: 'Add login' }, title: 'Add login', body: 'Closes #42', draft: true })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'permission_denied' })
  })
})

describe('AC-11 / EC-13 / EC-14 PR', () => {
  it('buildPrDraft(이슈) → title=이슈 제목, body 에 "Closes #42", draft 기본', () => {
    const d = buildPrDraft({ number: 42, title: 'Add login' })
    expect(d.title).toBe('Add login')
    expect(d.body).toContain('Closes #42')
    expect(d.draft).toBe(true)
    expect(d.titleRequired).toBe(false)
  })

  it('EC-14 buildPrDraft(★기타) → title 비움·필수, Closes 없음', () => {
    const d = buildPrDraft({ number: null, title: '' })
    expect(d.title).toBe('')
    expect(d.body).not.toMatch(/Closes/i)
    expect(d.titleRequired).toBe(true)
    expect(d.draft).toBe(true)
  })

  it('AC-11 열린 PR 없음 → base=default_branch 로 draft PR 생성, URL 반환', async () => {
    const t = setup(undefined, {
      defaultBranch: async () => 'develop',
      openPrForBranch: async () => null,
      createPr: async () => ({ number: 7, url: 'https://github.com/MyOrg/Repo-A/pull/7' }),
    })
    const res = await t.ops.createOrOpenPr({
      owner: 'MyOrg',
      repo: 'Repo-A',
      branch: BRANCH,
      issue: { number: 42, title: 'Add login' },
      title: 'Add login',
      body: 'Closes #42',
      draft: true,
    })
    expect(res).toEqual({ url: 'https://github.com/MyOrg/Repo-A/pull/7', number: 7, existing: false })
    expect(t.github.openPrForBranch).toHaveBeenCalledWith('MyOrg', 'Repo-A', BRANCH)
    expect(t.github.createPr).toHaveBeenCalledWith({
      owner: 'MyOrg',
      repo: 'Repo-A',
      base: 'develop',
      head: BRANCH,
      title: 'Add login',
      body: expect.stringContaining('Closes #42'),
      draft: true,
    })
  })

  it('EC-13 브랜치에 열린 PR 있음 → 생성하지 않고 기존 PR URL', async () => {
    const t = setup(undefined, { openPrForBranch: async () => ({ number: 3, url: 'https://github.com/MyOrg/Repo-A/pull/3' }) })
    const res = await t.ops.createOrOpenPr({ owner: 'MyOrg', repo: 'Repo-A', branch: BRANCH, issue: { number: 42, title: 'Add login' }, title: 'Add login', body: 'Closes #42', draft: true })
    expect(res).toEqual({ url: 'https://github.com/MyOrg/Repo-A/pull/3', number: 3, existing: true })
    expect(t.github.createPr).not.toHaveBeenCalled()
  })

  it('EC-14 ★기타에서 title 비어 있으면 title_required, 생성 호출 없음', async () => {
    const t = setup()
    await expect(
      t.ops.createOrOpenPr({ owner: 'MyOrg', repo: 'Repo-A', branch: 'etc', issue: { number: null, title: '' }, title: '   ', body: '', draft: true }),
    ).rejects.toMatchObject({ code: 'title_required' })
    expect(t.github.createPr).not.toHaveBeenCalled()
  })

  it('EC-14 ★기타에서 title 입력 시 Closes 없이 생성', async () => {
    const t = setup()
    await t.ops.createOrOpenPr({ owner: 'MyOrg', repo: 'Repo-A', branch: 'etc', issue: { number: null, title: '' }, title: 'chore: misc', body: 'misc', draft: true })
    expect(t.github.createPr).toHaveBeenCalledTimes(1)
    const input = t.github.createPr.mock.calls[0][0]
    expect(input.title).toBe('chore: misc')
    expect(input.body).not.toMatch(/Closes/i)
  })
})
