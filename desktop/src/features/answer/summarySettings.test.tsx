// 서버 설정 "세션 요약" 절(#122) — Claude 답변·Jev 판정 켜기, Jev API 키 저장·지우기(Plan §11, U8)
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import type { TauriApi } from '../../lib/tauri'
import { useServerStore } from '../../store/server'
import { useUiStore } from '../../store/ui'
import { SERVER_SETTINGS, createFakeTauri } from '../../test/fakes'
import { ServerSettingsDialog } from '../server/ServerSettingsDialog'

const running = { state: 'running' as const, port: 8787, message: null }

/** 키체인(Rust 안)을 흉내 낸다 — 화면은 저장 여부만 묻는다 */
function setup(overrides: Partial<TauriApi> = {}) {
  let saved = false
  const fake = createFakeTauri({
    serverSettingsGet: async () => SERVER_SETTINGS,
    jevKeyStatus: async () => saved,
    jevKeySet: async () => {
      saved = true
    },
    jevKeyDelete: async () => {
      saved = false
    },
    ...overrides,
  })
  useServerStore.setState({ status: running, settingsOpen: true })
  render(<ServerSettingsDialog tauri={fake.tauri} />)
  return { tauri: fake.tauri }
}

const section = async () => screen.findByRole('region', { name: '세션 요약' })
const keyInput = () => screen.getByLabelText('Jev API 키')

beforeEach(() => {
  useServerStore.setState(useServerStore.getInitialState(), true)
  useUiStore.setState({ summaryClaudeReply: true, summaryJev: false })
  localStorage.clear()
})

describe('SummarySettingsSection', () => {
  it('AC-11 "세션 요약" 절: Claude 답변 보이기(기본 켬)·Jev 판정 버튼 보이기(기본 끔)와 보내는 내용 안내 — 바꾸면 바로 적용된다', async () => {
    setup()
    const sec = await section()
    const claude = within(sec).getByRole('checkbox', { name: 'Claude Code 마지막 답변 앞부분 보이기' })
    expect(claude).toBeChecked()
    expect(claude).toHaveAccessibleDescription('세션 기록 파일을 읽기만 합니다.')
    const jev = within(sec).getByRole('checkbox', { name: 'Jev 판정 버튼 보이기' })
    expect(jev).not.toBeChecked()
    expect(jev).toHaveAccessibleDescription(/api\.typesafe\.ai/)
    fireEvent.click(jev)
    fireEvent.click(claude)
    expect(useUiStore.getState()).toMatchObject({ summaryJev: true, summaryClaudeReply: false })
  })

  it('AC-11 Jev API 키: 키체인에 저장하고 지우며 저장 여부를 보인다 — 키는 화면으로 읽지 않고, Enter 는 서버 설정이 아니라 키를 저장한다', async () => {
    const user = userEvent.setup()
    const { tauri } = setup()
    const sec = await section()
    expect(keyInput()).toHaveAttribute('type', 'password')
    expect(keyInput()).toHaveAttribute('autocomplete', 'off')
    await waitFor(() => expect(within(sec).getByRole('status')).toHaveTextContent('없음'))
    await user.type(keyInput(), 'sk-test-123{Enter}')
    await waitFor(() => expect(tauri.jevKeySet).toHaveBeenCalledWith('sk-test-123'))
    await waitFor(() => expect(within(sec).getByRole('status')).toHaveTextContent('저장됨'))
    expect(keyInput()).toHaveValue('')
    expect(tauri.serverSettingsSave).not.toHaveBeenCalled()
    expect(useServerStore.getState().settingsOpen).toBe(true)
    fireEvent.click(within(sec).getByRole('button', { name: 'Jev API 키 지우기' }))
    await waitFor(() => expect(tauri.jevKeyDelete).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(within(sec).getByRole('status')).toHaveTextContent('없음'))
    expect(tauri.keychainGet).not.toHaveBeenCalled()
  })

  it('AC-11 [Jev API 키 저장] 버튼으로도 저장한다(앞뒤 공백은 뗀다)', async () => {
    const { tauri } = setup()
    const sec = await section()
    fireEvent.change(keyInput(), { target: { value: '  sk-abc  ' } })
    fireEvent.click(within(sec).getByRole('button', { name: 'Jev API 키 저장' }))
    await waitFor(() => expect(tauri.jevKeySet).toHaveBeenCalledWith('sk-abc'))
  })

  it('AC-11 대화상자의 [저장]: 입력한 키가 있으면 서버 설정보다 먼저 저장하고 닫는다', async () => {
    const { tauri } = setup()
    await section()
    fireEvent.change(keyInput(), { target: { value: 'sk-on-save' } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(useServerStore.getState().settingsOpen).toBe(false))
    expect(tauri.jevKeySet).toHaveBeenCalledWith('sk-on-save')
  })

  it.each([
    ['잘못된 키(보이는 ASCII 밖 글자)', '키에-한글', null],
    ['키체인 오류', 'sk-ok', 'jev_keychain'],
  ])('AC-11 대화상자의 [저장]: %s 면 닫지 않고 서버 설정도 저장하지 않으며 알린다', async (_kind, value, error) => {
    const { tauri } = setup(
      error
        ? {
            jevKeySet: async () => {
              throw new Error(error)
            },
          }
        : {},
    )
    await section()
    fireEvent.change(screen.getByLabelText('포트'), { target: { value: '18787' } })
    fireEvent.change(keyInput(), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Jev API 키를 저장하지 못했습니다')
    expect(useServerStore.getState().settingsOpen).toBe(true)
    expect(tauri.serverSettingsSave).not.toHaveBeenCalled()
    if (!error) expect(tauri.jevKeySet).not.toHaveBeenCalled()
  })

  it('AC-11 취소한 뒤 다시 열면 키 입력 칸은 비어 있다(취소한 키가 남지 않는다)', async () => {
    const { tauri } = setup()
    await section()
    fireEvent.change(keyInput(), { target: { value: 'sk-cancel' } })
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    await waitFor(() => expect(useServerStore.getState().settingsOpen).toBe(false))
    act(() => useServerStore.setState({ settingsOpen: true }))
    await section()
    expect(keyInput()).toHaveValue('')
    expect(tauri.jevKeySet).not.toHaveBeenCalled()
  })
})
