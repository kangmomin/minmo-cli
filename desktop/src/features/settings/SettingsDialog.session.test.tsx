// 설정 저장 401 → 세션 삭제(UI State "세션 없음/401").
// 공통 처리는 앱 QueryClient 의 MutationCache(handleApiError)가 담당하므로 실제 createAppQueryClient 로 검증한다.
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import type { SettingsRecord } from '@minmo/api-client'

import { createAppQueryClient } from '../../app/createDeps'
import { useSessionStore } from '../../store/session'
import { apiError, createFakeApi } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { SettingsDialog } from './SettingsDialog'

const GLOBAL: SettingsRecord = {
  branchTemplate: 'issue/{number}-{slug}',
  etcBranchName: 'etc',
  worktreePath: '~/minmo-workspaces/{owner}/{repo}/{branch}',
  mainClonePath: '~/minmo-workspaces/{owner}/{repo}/_main',
  postCreateScript: '',
  sparsePaths: '',
  postCreateScriptPosix: '',
  updatedAt: '2026-11-09T00:00:00.000Z',
}

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
})

describe('settings 저장 401', () => {
  it('PUT 401 → 앱 공통 처리로 세션 삭제', async () => {
    const api = createFakeApi({
      getSettings: async () => GLOBAL,
      putSettings: async () => {
        throw apiError(401, 'unauthorized')
      },
    })
    const user = userEvent.setup()
    renderWithDeps(<SettingsDialog scope={{ kind: 'global' }} open onOpenChange={() => {}} />, makeDeps({ api }), createAppQueryClient())

    await waitFor(() => expect(screen.getByLabelText('브랜치 템플릿')).toHaveValue('issue/{number}-{slug}'))
    await user.click(screen.getByRole('button', { name: '저장' }))

    await waitFor(() => expect(api.putSettings).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useSessionStore.getState().token).toBeNull())
  })
})
