import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { useServerStore } from '../../store/server'
import { createFakeTauri } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { AppVersion } from './AppVersion'

beforeEach(() => useServerStore.setState({ settingsOpen: false }))

describe('버전 표시', () => {
  it('앱 버전을 보이고, 누르면 업데이트 확인이 있는 설정을 연다', async () => {
    const { tauri } = createFakeTauri({ appVersion: async () => '0.8.1' })
    renderWithDeps(<AppVersion />, makeDeps({ tauri }))
    const badge = await screen.findByRole('button', { name: '버전 0.8.1 — 업데이트 확인 열기' })
    expect(badge).toHaveTextContent('v0.8.1')
    await userEvent.setup().click(badge)
    expect(useServerStore.getState().settingsOpen).toBe(true)
  })

  it('버전을 알 수 없으면 아무것도 보이지 않는다', async () => {
    const { tauri } = createFakeTauri({
      appVersion: async () => {
        throw new Error('no ipc')
      },
    })
    const { container } = renderWithDeps(<AppVersion />, makeDeps({ tauri }))
    await Promise.resolve()
    expect(container).toBeEmptyDOMElement()
  })
})
