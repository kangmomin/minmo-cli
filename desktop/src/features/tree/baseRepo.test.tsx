// 기준 저장소(기존 폴더 가져오기) — 경로 검사·origin 확인·호스트별 저장, worktree 서비스에 반영
import { renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Effective } from '@minmo/api-client'
import { DEFAULT_SETTINGS } from '@minmo/core'

import { HostScope, hostOf } from '../../app/host'
import type { SshProbe } from '../../lib/tauri'
import { baseRepoOf, useHostsStore } from '../../store/hosts'
import { useSessionStore } from '../../store/session'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { createFakeApi, createFakeGitHub, createFakeTauri, fail, ok } from '../../test/fakes'
import { makeDeps, makeWrapper, renderWithDeps } from '../../test/render'
import { WorktreeProvider, useIssueActions } from '../issue/useWorktree'
import { BaseRepoDialog, repoOfRemote } from './BaseRepoDialog'

const PROBE: SshProbe = { platform: 'linux', home: '/home/dev', git: 'git version 2.43.0', tmux: true }

beforeEach(() => {
  localStorage.clear()
  useHostsStore.setState({ aliases: [], selected: null, probes: {}, connecting: null, error: null, baseRepos: {} })
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
  useSetupStore.setState(useSetupStore.getInitialState(), true)
  useUiStore.setState({ worktreePathMap: {}, selectedIssueId: null })
})

describe('repoOfRemote', () => {
  it('https·ssh 주소에서 owner/repo 를 읽는다', () => {
    expect(repoOfRemote('https://github.com/acme/app.git\n')).toBe('acme/app')
    expect(repoOfRemote('https://github.com/acme/app')).toBe('acme/app')
    expect(repoOfRemote('git@github.com:acme/app.git')).toBe('acme/app')
    expect(repoOfRemote('ssh://git@github.com/acme/app.git/')).toBe('acme/app')
    expect(repoOfRemote('')).toBeNull()
  })
})

describe('BaseRepoDialog', () => {
  function setup(git: (args: string[]) => ReturnType<typeof ok>) {
    const { tauri } = createFakeTauri({ gitRun: async (args) => git(args) })
    renderWithDeps(<BaseRepoDialog owner="acme" repo="app" open onOpenChange={() => {}} />, makeDeps({ tauri, home: '/home/u', platform: 'linux' }))
    return { tauri, user: userEvent.setup() }
  }
  /** rev-parse 는 최상위 폴더와 공용 git 폴더를 돌려준다(일반 저장소면 <최상위>/.git) */
  const repoAt = (top: string, common = `${top}/.git`) => ok(`${top}\n${common}\n`)
  const good = (args: string[]) => (args.includes('get-url') ? ok('git@github.com:Acme/App.git\n') : repoAt(args[1]))

  it('~ 경로를 풀어 검사하고 저장한다(이 PC 기준)', async () => {
    const { tauri, user } = setup(good)
    await user.type(screen.getByLabelText('저장소 폴더'), '~/src/app/')
    await user.click(screen.getByRole('button', { name: '확인' }))
    expect(await screen.findByText('확인됨 — origin: Acme/App')).toBeInTheDocument()
    expect(tauri.gitRun).toHaveBeenCalledWith(['-C', '/home/u/src/app', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'])
    await user.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(baseRepoOf(useHostsStore.getState(), 'local', 'Acme', 'APP')).toBe('/home/u/src/app'))
  })

  it('git 저장소가 아니면 저장하지 않는다 · 상대 경로·템플릿 기호는 거부', async () => {
    const { user } = setup((args) => (args.includes('rev-parse') ? fail('fatal: not a git repository') : ok()))
    const input = screen.getByLabelText('저장소 폴더')
    await user.type(input, 'src/app')
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('절대 경로')
    await user.clear(input)
    await user.type(input, '/srv/{{owner}/app')
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('{ } 를 쓸 수 없습니다')
    await user.clear(input)
    await user.type(input, '/srv/app')
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('git 저장소(작업 폴더)가 아닙니다')
    expect(useHostsStore.getState().baseRepos).toEqual({})
  })

  it('origin 이 다른 저장소면 경고만 하고 저장은 된다 · [해제] 로 지운다', async () => {
    useHostsStore.getState().setBaseRepo('local', 'acme', 'app', '/old/path/app')
    const { user } = setup((args) => (args.includes('get-url') ? ok('https://github.com/fork/app.git') : repoAt(args[1])))
    const input = screen.getByLabelText('저장소 폴더')
    expect(input).toHaveValue('/old/path/app')
    await user.clear(input)
    await user.type(input, '/srv/fork/app')
    await user.click(screen.getByRole('button', { name: '확인' }))
    expect(await screen.findByText('origin 이 다른 저장소입니다: fork/app')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(baseRepoOf(useHostsStore.getState(), 'local', 'acme', 'app')).toBe('/srv/fork/app'))
  })
})

describe('BaseRepoDialog — 받지 않는 폴더', () => {
  async function tryPath(git: (args: string[]) => ReturnType<typeof ok>) {
    const { tauri } = createFakeTauri({ gitRun: async (args) => git(args) })
    renderWithDeps(<BaseRepoDialog owner="acme" repo="app" open onOpenChange={() => {}} />, makeDeps({ tauri, home: '/home/u', platform: 'linux' }))
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('저장소 폴더'), '/srv/app/sub')
    await user.click(screen.getByRole('button', { name: '저장' }))
    return screen.findByRole('alert')
  }

  it('저장소의 하위 폴더는 최상위를 지정하라고 안내한다', async () => {
    expect(await tryPath(() => ok('/srv/app\n/srv/app/.git\n'))).toHaveTextContent('저장소의 최상위 폴더를 지정하세요: /srv/app')
    expect(useHostsStore.getState().baseRepos).toEqual({})
  })

  it('다른 저장소에 딸린 worktree 는 받지 않는다', async () => {
    expect(await tryPath(() => ok('/srv/app/sub\n/srv/main/.git\n'))).toHaveTextContent('원래 저장소 폴더를 지정하세요')
    expect(useHostsStore.getState().baseRepos).toEqual({})
  })

  it('bare 저장소는 받지 않는다(작업 폴더 없음)', async () => {
    expect(await tryPath(() => fail('fatal: this operation must be run in a work tree'))).toHaveTextContent('git 저장소(작업 폴더)가 아닙니다')
  })
})

describe('worktree 서비스에 반영', () => {
  it('기준 저장소 폴더가 없어졌으면 그 자리에 clone 하지 않고 알린다', async () => {
    useHostsStore.getState().setBaseRepo('local', 'acme', 'app', '/srv/gone/app')
    const { tauri } = createFakeTauri({ pathExists: async () => false })
    const api = createFakeApi({ getEffective: async () => ({ values: { ...DEFAULT_SETTINGS }, sources: {} }) as unknown as Effective })
    const Base = makeWrapper(makeDeps({ tauri, api }))
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Base>
        <WorktreeProvider>{children}</WorktreeProvider>
      </Base>
    )
    const { result } = renderHook(() => useIssueActions(), { wrapper })
    await result.current.open({ owner: 'acme', repo: 'app', key: '7', number: 7, title: 'Fix' })
    await waitFor(() => expect(useSetupStore.getState().open['acme/app#7']).toMatchObject({ phase: 'error', message: expect.stringContaining('기준 저장소 폴더가 없습니다') }))
    expect(tauri.gitRun.mock.calls.some(([args]) => args.includes('clone'))).toBe(false)
  })

  it('기준 저장소가 있는 호스트에서는 clone 하지 않고 그 저장소에서 worktree 를 만든다', async () => {
    useHostsStore.setState({ probes: { srv: PROBE } })
    const host = hostOf('srv', true)
    useHostsStore.getState().setBaseRepo(host.id, 'acme', 'app', '/home/dev/src/app')
    const copied: string[] = []
    const { tauri } = createFakeTauri({
      sshExec: async (_h, argv) => {
        // 기준 저장소는 이미 있고, worktree 폴더는 아직 없다
        if (argv[0] === 'test') return argv[2] === '/home/dev/src/app' ? ok() : fail('', 1)
        if (argv[0] === 'sh' && argv[1] === '-s') {
          copied.push(argv[3])
          return ok('0')
        }
        const args = argv[0] === 'git' ? argv.slice(1) : argv
        if (args.includes('worktree') && args.includes('list')) return ok('')
        if (args.includes('rev-parse') && args.includes('--verify')) return fail('', 1)
        return ok('')
      },
    })
    const api = createFakeApi({ getEffective: async () => ({ values: { ...DEFAULT_SETTINGS }, sources: {} }) as unknown as Effective })
    const deps = makeDeps({ tauri, api, github: createFakeGitHub({ defaultBranch: async () => 'main' }) })
    const Base = makeWrapper(deps)
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Base>
        <WorktreeProvider>
          <HostScope alias="srv">{children}</HostScope>
        </WorktreeProvider>
      </Base>
    )
    const { result } = renderHook(() => useIssueActions(), { wrapper })
    await result.current.open({ owner: 'acme', repo: 'app', key: '7', number: 7, title: 'Fix' })

    const id = host.issueId('acme', 'app', '7')
    await waitFor(() => expect(useSetupStore.getState().open[id]).toMatchObject({ phase: 'ready' }))
    const gitCalls = tauri.sshExec.mock.calls.map(([, argv]) => argv).filter((a) => a[0] === 'git')
    expect(gitCalls.some((a) => a.includes('clone'))).toBe(false)
    expect(gitCalls.some((a) => a[1] === '-C' && a[2] === '/home/dev/src/app' && a.includes('fetch'))).toBe(true)
    expect(gitCalls.some((a) => a[2] === '/home/dev/src/app' && a.includes('worktree') && a.includes('add'))).toBe(true)
    // 보관 폴더는 옆 폴더(_local)가 아니라 그 저장소의 .git 안
    expect(copied).toEqual(['/home/dev/src/app/.git/minmo-local'])
  })
})
