// 전역 설정 — 경로·스크립트를 다른 PC 와 공유할지(끄면 이 PC 에만 저장)
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import type { ServerSettings } from '../../lib/tauri'
import { createAppApi } from '../../lib/api'
import { useServerStore } from '../../store/server'
import { useSessionStore } from '../../store/session'
import { SERVER_SETTINGS, createFakeTauri } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { SharePathsSection } from './SharePathsSection'

const PC = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  useServerStore.setState(useServerStore.getInitialState(), true)
  useSessionStore.setState(useSessionStore.getInitialState(), true)
})

function setup(runtime: 'native' | 'mock' = 'native') {
  let settings: ServerSettings = { ...SERVER_SETTINGS, sharePaths: false, pcId: PC }
  const fake = createFakeTauri({
    serverSettingsGet: async () => settings,
    serverSettingsSave: async (input) => {
      const sharePaths = input.sharePaths ?? settings.sharePaths ?? false
      settings = { ...settings, sharePaths, pcId: sharePaths ? null : PC }
      return settings
    },
  })
  const tauri = { ...fake.tauri, runtime }
  const view = renderWithDeps(<SharePathsSection />, makeDeps({ tauri }))
  return { tauri: fake.tauri, queryClient: view.queryClient, user: userEvent.setup() }
}

describe('경로·스크립트 공유', () => {
  it('기본은 꺼짐 — 켜면 저장하고 PC 식별자를 떼며, 설정·경로 미리보기를 다시 읽게 한다', async () => {
    useServerStore.setState({ pcId: PC })
    const { tauri, queryClient, user } = setup()
    queryClient.setQueryData(['settings', 'global'], {})
    queryClient.setQueryData(['effective', 'o', 'r'], {})
    queryClient.setQueryData(['notes', 'o', 'r', '1'], {})
    const box = await screen.findByRole('checkbox', { name: '경로·스크립트를 다른 PC 와 공유' })
    await waitFor(() => expect(box).toBeEnabled())
    expect(box).not.toBeChecked()

    await user.click(box)
    await waitFor(() => expect(box).toBeChecked())
    expect(tauri.serverSettingsSave).toHaveBeenCalledWith({ sharePaths: true })
    expect(useServerStore.getState().pcId).toBeNull()
    expect(queryClient.getQueryState(['settings', 'global'])?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['effective', 'o', 'r'])?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['notes', 'o', 'r', '1'])?.isInvalidated).toBe(false)

    // 다시 끄면 이 PC 의 식별자를 다시 붙인다
    await user.click(box)
    await waitFor(() => expect(useServerStore.getState().pcId).toBe(PC))
    expect(box).not.toBeChecked()
  })

  it('앱의 API 요청은 store 의 PC 식별자를 설정 요청에 붙인다', async () => {
    const seen: (string | null)[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('x-minmo-pc'))
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const api = createAppApi('http://127.0.0.1:8787')
      useServerStore.setState({ pcId: PC })
      await api.getEffective('o', 'r')
      useServerStore.setState({ pcId: null })
      await api.getEffective('o', 'r')
    } finally {
      globalThis.fetch = realFetch
    }
    expect(seen).toEqual([PC, null])
  })

  it('이 PC 의 창이 아니면(원격 화면·mock) 보이지 않는다 — 호스트 PC 의 설정을 따른다', () => {
    setup('mock')
    expect(screen.queryByTestId('share-paths-section')).toBeNull()
  })
})
