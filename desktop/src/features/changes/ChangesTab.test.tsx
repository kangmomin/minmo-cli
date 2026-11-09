// 변경 탭 — diff 재조회 범위(CR-04)·피드백 live region(AX-04~11)
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { TauriApi } from '../../lib/tauri'
import { createFakeTauri, fail, flush, ok } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { ChangesTab } from './ChangesTab'
import type { UseGitTarget } from './useGit'

const H = '0000000000000000000000000000000000000000'
const CWD = '/w/42'
const TARGET: UseGitTarget = { owner: 'o', repo: 'r', branch: 'issue/42-x', cwd: CWD, issue: { number: 42, title: 'X' } }
const line = (xy: string, path: string) => `1 ${xy} N... 100644 100644 100644 ${H} ${H} ${path}`

function setup(git: { status: string[]; push?: () => ReturnType<TauriApi['gitRun']> }) {
  const fake = createFakeTauri({
    gitRun: async (args) => {
      const a = args.slice(args.indexOf('-C') >= 0 ? 2 : 0)
      if (a[0] === 'status') return ok(git.status.join('\n') + '\n')
      if (a[0] === 'diff') return ok(`diff of ${a[a.length - 1]}`)
      if (a[0] === 'rev-list') return ok('0\n')
      if (a[0] === 'push' && git.push) return git.push()
      return ok()
    },
  })
  renderWithDeps(<ChangesTab target={TARGET} />, makeDeps({ tauri: fake.tauri }))
  const diffCalls = () => fake.tauri.gitRun.mock.calls.filter(([args]) => args.includes('diff'))
  return { tauri: fake.tauri, diffCalls }
}

describe('CR-04 선택 파일 diff 는 그 파일의 상태가 바뀔 때만 다시 불러온다', () => {
  it('다른 파일이 추가돼 목록이 갱신돼도 선택 파일 diff 를 재조회하지 않는다', async () => {
    const git = { status: [line('.M', 'src/a.ts')] }
    const t = setup(git)
    fireEvent.click(await screen.findByRole('button', { name: 'src/a.ts' }))
    await waitFor(() => expect(screen.getByLabelText('diff')).toHaveTextContent('diff of src/a.ts'))
    expect(t.diffCalls()).toHaveLength(1)

    git.status = [line('.M', 'src/a.ts'), line('.M', 'src/b.ts')]
    fireEvent.click(screen.getByRole('button', { name: '변경 새로고침' }))
    await screen.findByRole('button', { name: 'src/b.ts' })
    await flush()
    expect(t.diffCalls()).toHaveLength(1)
    expect(screen.getByLabelText('diff')).toHaveTextContent('diff of src/a.ts')
  })

  it('선택 파일이 staged 로 바뀌면 --cached 로 다시 불러온다', async () => {
    const git = { status: [line('.M', 'src/a.ts')] }
    const t = setup(git)
    fireEvent.click(await screen.findByRole('button', { name: 'src/a.ts' }))
    await waitFor(() => expect(t.diffCalls()).toHaveLength(1))
    git.status = [line('M.', 'src/a.ts')]
    fireEvent.click(screen.getByRole('button', { name: '변경 새로고침' }))
    await waitFor(() => expect(t.diffCalls()).toHaveLength(2))
    expect(t.diffCalls()[1][0]).toContain('--cached')
  })
})

describe('CR-09 선택 파일이 목록에서 사라지면 diff 도 해제', () => {
  it('커밋 등으로 파일이 사라지면 옛 diff 를 지우고 안내 문구로 돌아간다(다시 나타나도 자동 선택 없음)', async () => {
    const git = { status: [line('.M', 'src/a.ts'), line('.M', 'src/b.ts')] }
    const t = setup(git)
    fireEvent.click(await screen.findByRole('button', { name: 'src/a.ts' }))
    await waitFor(() => expect(screen.getByLabelText('diff')).toHaveTextContent('diff of src/a.ts'))

    git.status = [line('.M', 'src/b.ts')]
    fireEvent.click(screen.getByRole('button', { name: '변경 새로고침' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'src/a.ts' })).toBeNull())
    await waitFor(() => expect(screen.getByLabelText('diff')).toHaveTextContent('파일을 선택하면 diff 를 표시합니다'))
    expect(screen.getByLabelText('diff')).not.toHaveTextContent('diff of src/a.ts')

    const before = t.diffCalls().length
    git.status = [line('.M', 'src/a.ts'), line('.M', 'src/b.ts')]
    fireEvent.click(screen.getByRole('button', { name: '변경 새로고침' }))
    await screen.findByRole('button', { name: 'src/a.ts' })
    await flush()
    expect(t.diffCalls()).toHaveLength(before)
    expect(screen.getByLabelText('diff')).toHaveTextContent('파일을 선택하면 diff 를 표시합니다')
  })
})

describe('AX 변경 탭 피드백 live region', () => {
  it('실패 피드백은 role=alert', async () => {
    setup({ status: [line('.M', 'src/a.ts')], push: async () => fail('! [rejected] non-fast-forward', 1) })
    await screen.findByRole('button', { name: 'src/a.ts' })
    fireEvent.click(screen.getByRole('button', { name: /push/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/push 거절됨|git 실패/)
  })

  it('성공 피드백은 role=status', async () => {
    setup({ status: [line('.M', 'src/a.ts')], push: async () => ok() })
    await screen.findByRole('button', { name: 'src/a.ts' })
    fireEvent.click(screen.getByRole('button', { name: /push/ }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('push 완료'))
  })
})
