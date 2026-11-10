// 레포별 로컬 파일 보관 폴더 다이얼로그 — 목록·보관·보관 해제·폴더 열기, 결과는 live region 으로 안내
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { worktreeId } from '../../lib/worktree'
import type { IssueTarget } from '../../lib/worktree'
import { useUiStore } from '../../store/ui'
import { createFakeTauri, ok } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { LocalFilesDialog } from './LocalFilesDialog'
import { WorktreeProvider } from './useWorktree'

const T: IssueTarget = { owner: 'o', repo: 'r', key: '42', number: 42, title: 'X' }
const WT = '/home/u/ws/o/r/issue--42'
const LOCAL = '/home/u/ws/o/r/_local'

function setup(initial: string[] = []) {
  let files = [...initial]
  const { tauri } = createFakeTauri({
    // 메인 clone 은 worktree 의 git common dir 로 찾는다
    gitRun: async (args) => (args.includes('--git-common-dir') ? ok('/home/u/ws/o/r/_main/.git\n') : ok()),
    listFiles: async () => [...files].sort(),
    copyFileInto: async (_src, rel) => {
      files = [...new Set([...files, rel])]
    },
    removeFileIn: async (_root, rel) => {
      files = files.filter((f) => f !== rel)
    },
  })
  renderWithDeps(
    <WorktreeProvider>
      <LocalFilesDialog target={T} worktreePath={WT} open onOpenChange={() => {}} />
    </WorktreeProvider>,
    makeDeps({ tauri }),
  )
  return { tauri, user: userEvent.setup() }
}

beforeEach(() => {
  useUiStore.setState({ worktreePathMap: { [worktreeId('o', 'r', '42')]: { path: WT, branch: 'b' } } })
})

describe('로컬 파일 다이얼로그', () => {
  it('보관 폴더(_local)와 보관된 파일 목록을 보여 준다', async () => {
    const { tauri } = setup(['.env', 'config/local.json'])
    expect(await screen.findByText(LOCAL)).toBeInTheDocument()
    expect(await screen.findByText('config/local.json')).toBeInTheDocument()
    expect(tauri.listFiles).toHaveBeenCalledWith(LOCAL)
  })

  it('현재 worktree 의 .env 를 보관하고 목록을 갱신·안내한다', async () => {
    const { tauri, user } = setup()
    expect(await screen.findByText('보관된 파일이 없습니다')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '보관' }))
    await waitFor(() => expect(tauri.copyFileInto).toHaveBeenCalledWith(WT, '.env', LOCAL))
    expect(await screen.findByText('.env')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('.env 을(를) 보관했습니다')
  })

  it('보관 해제·폴더 열기, 실패는 alert', async () => {
    const { tauri, user } = setup(['.env'])
    await user.click(await screen.findByRole('button', { name: '.env 보관 해제' }))
    await waitFor(() => expect(tauri.removeFileIn).toHaveBeenCalledWith(LOCAL, '.env'))
    expect(await screen.findByText('보관된 파일이 없습니다')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '폴더 열기' }))
    expect(tauri.openDir).toHaveBeenCalledWith(LOCAL)

    tauri.copyFileInto.mockRejectedValueOnce(new Error('파일이 없습니다: .env'))
    await user.click(screen.getByRole('button', { name: '보관' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('파일이 없습니다')
  })
})
