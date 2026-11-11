// 앱 업데이트 — 시작 후 확인·안내 띠·설치 진행·오류·나중에, 서버 설정의 [업데이트 확인]
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UpdateInfo } from '../../lib/tauri'
import { useUpdateStore } from '../../store/update'
import { createFakeTauri } from '../../test/fakes'
import { AppUpdateSection } from './AppUpdateSection'
import { UPDATE_CHECK_DELAY_MS, UPDATE_RECHECK_MS, UpdateNotice } from './UpdateNotice'
import { checkForUpdate, progressPercent } from './update'

const NEXT: UpdateInfo = { version: '0.4.1', currentVersion: '0.4.0', notes: null, date: null }

beforeEach(() => {
  useUpdateStore.setState(useUpdateStore.getInitialState(), true)
})
afterEach(() => {
  vi.useRealTimers()
})

async function showNotice(overrides: Parameters<typeof createFakeTauri>[0] = {}) {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const fake = createFakeTauri({ appUpdateCheck: async () => NEXT, ...overrides })
  render(<UpdateNotice tauri={fake.tauri} />)
  expect(fake.tauri.appUpdateCheck).not.toHaveBeenCalled()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS)
  })
  return fake
}

describe('UpdateNotice', () => {
  it('시작 후 잠시 뒤 확인하고, 새 버전이 있으면 안내한다', async () => {
    await showNotice()
    expect(await screen.findByTestId('update-notice')).toHaveTextContent('새 버전 v0.4.1 이 있습니다(현재 v0.4.0)')
  })

  it('트레이에 오래 떠 있어도 주기적으로 다시 확인한다', async () => {
    const fake = await showNotice({ appUpdateCheck: async () => null })
    await waitFor(() => expect(fake.tauri.appUpdateCheck).toHaveBeenCalledTimes(1))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_MS)
    })
    expect(fake.tauri.appUpdateCheck).toHaveBeenCalledTimes(2)
  })

  it('새 버전이 없거나 확인이 실패하면 아무것도 보이지 않는다', async () => {
    const fake = await showNotice({
      appUpdateCheck: async () => {
        throw new Error('offline')
      },
    })
    await waitFor(() => expect(fake.tauri.appUpdateCheck).toHaveBeenCalled())
    expect(screen.queryByTestId('update-notice')).toBeNull()
  })

  it('[나중에]는 같은 버전 안내를 숨긴다', async () => {
    await showNotice()
    fireEvent.click(await screen.findByRole('button', { name: '나중에' }))
    expect(screen.queryByTestId('update-notice')).toBeNull()
    expect(useUpdateStore.getState().dismissed).toBe('0.4.1')
  })

  it('[설치하고 다시 시작] → 진행률을 보여 준다', async () => {
    let finish: () => void = () => {}
    const fake = await showNotice({ appUpdateInstall: () => new Promise<void>((r) => (finish = r)) })
    fireEvent.click(await screen.findByRole('button', { name: '설치하고 다시 시작' }))
    await waitFor(() => expect(fake.tauri.appUpdateInstall).toHaveBeenCalled())
    act(() => fake.emitUpdateProgress({ downloaded: 30, total: 120 }))
    expect(screen.getByTestId('update-notice')).toHaveTextContent('v0.4.1 받는 중 25%')
    expect(screen.queryByRole('button', { name: '나중에' })).toBeNull()
    await act(async () => finish())
  })

  it('설치 실패는 원인과 [다시 시도]', async () => {
    await showNotice({
      appUpdateInstall: async () => {
        throw new Error('서명이 맞지 않습니다')
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: '설치하고 다시 시작' }))
    expect(await screen.findByText(/업데이트하지 못했습니다 — 서명이 맞지 않습니다/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument()
  })
})

describe('checkForUpdate', () => {
  it('자동 확인 실패는 조용히, 직접 확인 실패는 알린다', async () => {
    const { tauri } = createFakeTauri({
      appUpdateCheck: async () => {
        throw new Error('네트워크')
      },
    })
    await expect(checkForUpdate(tauri)).resolves.toBeNull()
    await expect(checkForUpdate(tauri, true)).rejects.toThrow('네트워크')
  })

  it('직접 확인하면 [나중에]로 숨긴 안내를 다시 보인다', async () => {
    useUpdateStore.setState({ dismissed: '0.4.1' })
    const { tauri } = createFakeTauri({ appUpdateCheck: async () => NEXT })
    await checkForUpdate(tauri, true)
    expect(useUpdateStore.getState()).toMatchObject({ available: NEXT, dismissed: null })
  })

  it('progressPercent', () => {
    expect(progressPercent(null)).toBeNull()
    expect(progressPercent({ downloaded: 5, total: null })).toBeNull()
    expect(progressPercent({ downloaded: 50, total: 200 })).toBe(25)
    expect(progressPercent({ downloaded: 300, total: 200 })).toBe(100)
  })
})

describe('AppUpdateSection', () => {
  it('현재 버전과 확인 결과', async () => {
    const fake = createFakeTauri()
    render(<AppUpdateSection tauri={fake.tauri} headingId="app" />)
    expect(await screen.findByTestId('app-version')).toHaveTextContent('minmo v0.4.0')
    fireEvent.click(screen.getByRole('button', { name: '업데이트 확인' }))
    expect(await screen.findByText('최신 버전입니다')).toBeInTheDocument()

    fake.tauri.appUpdateCheck.mockResolvedValueOnce(NEXT)
    fireEvent.click(screen.getByRole('button', { name: '업데이트 확인' }))
    expect(await screen.findByText(/새 버전 v0\.4\.1 이 있습니다/)).toBeInTheDocument()
    expect(useUpdateStore.getState().available).toEqual(NEXT)
  })

  it('확인 실패를 보여 준다', async () => {
    const fake = createFakeTauri({
      appUpdateCheck: async () => {
        throw new Error('rate limit')
      },
    })
    render(<AppUpdateSection tauri={fake.tauri} headingId="app" />)
    fireEvent.click(await screen.findByRole('button', { name: '업데이트 확인' }))
    expect(await screen.findByText(/확인하지 못했습니다: rate limit/)).toBeInTheDocument()
  })
})
