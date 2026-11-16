// 기준 저장소 폴더 확인·기본 폴더 입력 검사 (데스크탑·원격 CLI 공용)
import { describe, expect, it } from 'vitest'

import { baseRepoLocalDir, checkBaseDir, resolveInputPath, verifyRepoFolder } from './repoFolder'
import { createFakeHost, fail, ok } from './testing'

const ENV = { home: '/home/u', platform: 'linux' as const }

describe('resolveInputPath', () => {
  it('~ 를 풀고 끝 구분자를 뗀다. 루트는 남긴다', () => {
    expect(resolveInputPath('~/src/', ENV)).toEqual({ path: '/home/u/src' })
    expect(resolveInputPath('/', ENV)).toEqual({ path: '/' })
    expect(resolveInputPath('C:\\', { home: 'C:\\Users\\u', platform: 'win32' })).toEqual({ path: 'C:\\' })
  })

  it('상대 경로·빈 값·템플릿 기호는 받지 않는다', () => {
    for (const bad of ['src', '', '  ', '/w/{repo}']) expect(resolveInputPath(bad, ENV)).toHaveProperty('error')
  })
})

describe('verifyRepoFolder', () => {
  const host = (top: string, common: string, origin = ok('https://github.com/o/r.git\n')) =>
    createFakeHost({
      gitRun: async (args) => {
        if (args.includes('--show-toplevel')) return ok(`${top}\n${common}\n`)
        if (args.includes('get-url')) return origin
        return ok('abc\n')
      },
    })

  it('작업 폴더가 있는 저장소의 최상위 → git 이 돌려준 경로와 origin', async () => {
    await expect(verifyRepoFolder(host('/w/r', '/w/r/.git'), ENV, '/w/r/')).resolves.toEqual({ ok: true, top: '/w/r', origin: 'https://github.com/o/r.git', hasCommits: true })
    await expect(verifyRepoFolder(host('/w/r', '/w/r/.git', fail('no remote')), ENV, '/w/r')).resolves.toMatchObject({ ok: true, origin: null })
  })

  it('하위 폴더·다른 저장소의 worktree·저장소가 아닌 폴더는 거절한다', async () => {
    await expect(verifyRepoFolder(host('/w/r', '/w/r/.git'), ENV, '/w/r/sub')).resolves.toMatchObject({ ok: false, error: expect.stringContaining('최상위') })
    await expect(verifyRepoFolder(host('/w/wt', '/w/r/.git'), ENV, '/w/wt')).resolves.toMatchObject({ ok: false, error: expect.stringContaining('worktree') })
    const notRepo = createFakeHost({ gitRun: async () => fail('fatal: not a git repository', 128) })
    await expect(verifyRepoFolder(notRepo, ENV, '/w/x')).resolves.toMatchObject({ ok: false, error: expect.stringContaining('not a git repository') })
    // 쓸 수 없는 입력은 git 을 부르지 않는다
    await expect(verifyRepoFolder(notRepo, ENV, 'rel')).resolves.toMatchObject({ ok: false })
    expect(notRepo.gitRun).toHaveBeenCalledTimes(1)
  })
})

describe('baseRepoLocalDir', () => {
  it('저장소의 .git 안에 둔다', () => {
    expect(baseRepoLocalDir('/w/r/', 'linux')).toBe('/w/r/.git/minmo-local')
    expect(baseRepoLocalDir('C:\\w\\r', 'win32')).toBe('C:\\w\\r\\.git\\minmo-local')
  })
})

describe('checkBaseDir', () => {
  it('~ 로 시작하거나 그 OS 의 절대 경로만 받는다', () => {
    for (const good of ['~', '~/ws', '/workspace', ' /workspace/ ']) expect(checkBaseDir(good, 'linux')).toBeNull()
    expect(checkBaseDir('D:\\ws', 'win32')).toBeNull()
    expect(checkBaseDir('~\\ws', 'win32')).toBeNull()
    for (const bad of ['', 'ws', 'D:\\ws', '~user/ws', '/w/{owner}']) expect(checkBaseDir(bad, 'linux')).not.toBeNull()
    expect(checkBaseDir('/workspace', 'win32')).not.toBeNull()
  })
})
