// 경로·스크립트 공유를 바꾸면 설정 폼이 새 기준(이 PC 의 값 ↔ 함께 쓰는 값)으로 다시 채워진다
import { act, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import type { SettingsRecord } from '@minmo/api-client'

import { useServerStore } from '../../store/server'
import { useSessionStore } from '../../store/session'
import { createFakeApi } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { SettingsDialog } from './SettingsDialog'

const PC = '11111111-1111-4111-8111-111111111111'
// 서버는 두 행에 같은 수정 시각을 쓴다 — 시각만으로는 값이 바뀐 것을 알 수 없다
const RECORD: SettingsRecord = {
  branchTemplate: 'issue/{number}-{slug}',
  etcBranchName: 'etc',
  worktreePath: '~/shared/{branch}',
  mainClonePath: '~/shared/{repo}/_main',
  postCreateScript: '',
  sparsePaths: '',
  postCreateScriptPosix: '',
  ignoredCopyExclude: 'node_modules',
  updatedAt: '2026-11-09T00:00:00.000Z',
}

beforeEach(() => {
  useServerStore.setState(useServerStore.getInitialState(), true)
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
})

describe('경로·스크립트 공유를 바꾼 뒤의 설정 폼', () => {
  it('수정 시각이 같아도 폼을 다시 채운다 — 남은 값을 저장해 다른 PC 의 경로를 바꾸지 않게', async () => {
    useServerStore.setState({ pcId: PC })
    // 가짜 서버: PC 식별자가 있으면 이 PC 의 경로, 없으면 함께 쓰는 경로
    const api = createFakeApi({
      getSettings: async () => (useServerStore.getState().pcId ? { ...RECORD, worktreePath: 'D:/work/{branch}' } : RECORD),
    })
    const { queryClient } = renderWithDeps(
      <SettingsDialog scope={{ kind: 'global' }} open onOpenChange={() => {}} previewIssue={null} />,
      makeDeps({ api, home: '/home/u', platform: 'linux' }),
    )
    expect(await screen.findByLabelText('worktree 경로')).toHaveValue('D:/work/{branch}')

    // 공유를 켠다(SharePathsSection 이 하는 일): 식별자를 떼고 설정을 다시 읽는다
    await act(async () => {
      useServerStore.getState().setPcId(null)
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
    })
    await waitFor(() => expect(screen.getByLabelText('worktree 경로')).toHaveValue('~/shared/{branch}'))
  })
})
