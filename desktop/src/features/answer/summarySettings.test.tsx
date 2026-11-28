// 설정 화면 서버·앱 분류의 "세션 요약" 절(#122) — Claude 답변·Jev 판정 켜기, Jev API 키 저장·지우기(Plan §11, U8)
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { TooltipProvider } from '../../components/ui/tooltip'
import type { TauriApi } from '../../lib/tauri'
import { openSettings, useSettingsPageStore } from '../../store/settingsPage'
import { useUiStore } from '../../store/ui'
import { SERVER_SETTINGS, createFakeTauri } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { SettingsPage } from '../settings/SettingsPage'

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
  renderWithDeps(
    <TooltipProvider>
      <SettingsPage />
    </TooltipProvider>,
    makeDeps({ tauri: fake.tauri }),
  )
  act(() => openSettings({ section: 'server' }))
  return { tauri: fake.tauri }
}

const section = async () => screen.findByRole('region', { name: '세션 요약' })
const keyInput = () => screen.getByLabelText('Jev API 키')

beforeEach(() => {
  useSettingsPageStore.setState(useSettingsPageStore.getInitialState(), true)
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

  it('AC-11 설정 화면의 서버·앱 분류에 있고, 설정 검색 "Jev"·"세션 요약" 으로 찾는다', async () => {
    setup()
    const dlg = await screen.findByRole('dialog', { name: '설정' })
    expect(within(dlg).getByRole('tab', { name: '서버·앱', selected: true })).toBeInTheDocument()
    await section()
    for (const query of ['Jev', '세션 요약']) {
      fireEvent.change(within(dlg).getByRole('searchbox', { name: '설정 검색' }), { target: { value: query } })
      await waitFor(() => expect(within(dlg).getAllByRole('tab').map((t) => t.textContent)).toEqual(['서버·앱']))
    }
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
    expect(useSettingsPageStore.getState().open).toBe(true)
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

  it.each([
    ['잘못된 키(보이는 ASCII 밖 글자)', '키에-한글', null],
    ['키체인 오류', 'sk-ok', 'jev_keychain'],
  ])('AC-11 [Jev API 키 저장]: %s 면 알리고 입력한 키를 지우지 않는다', async (_kind, value, error) => {
    const { tauri } = setup(
      error
        ? {
            jevKeySet: async () => {
              throw new Error(error)
            },
          }
        : {},
    )
    const sec = await section()
    fireEvent.change(keyInput(), { target: { value } })
    fireEvent.click(within(sec).getByRole('button', { name: 'Jev API 키 저장' }))
    expect(await within(sec).findByRole('alert')).toHaveTextContent('Jev API 키를 저장하지 못했습니다')
    expect(keyInput()).toHaveValue(value)
    if (!error) expect(tauri.jevKeySet).not.toHaveBeenCalled()
  })

  it('AC-11 서버 폼의 [저장] 은 서버 설정만 저장한다 — 입력 중인 키는 저장하지 않고 칸에 남는다', async () => {
    const { tauri } = setup()
    await section()
    fireEvent.change(screen.getByLabelText('포트'), { target: { value: '18787' } })
    fireEvent.change(keyInput(), { target: { value: 'sk-typed' } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(tauri.serverSettingsSave).toHaveBeenCalledWith({ port: 18787 }))
    expect(tauri.jevKeySet).not.toHaveBeenCalled()
    expect(keyInput()).toHaveValue('sk-typed')
  })

  it('AC-11 설정을 닫았다 다시 열면 키 입력 칸은 비어 있다(취소한 키가 남지 않는다)', async () => {
    const { tauri } = setup()
    await section()
    fireEvent.change(keyInput(), { target: { value: 'sk-cancel' } })
    fireEvent.click(screen.getByRole('button', { name: '닫기' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '설정' })).not.toBeInTheDocument())
    act(() => openSettings({ section: 'server' }))
    await section()
    expect(keyInput()).toHaveValue('')
    expect(tauri.jevKeySet).not.toHaveBeenCalled()
  })
})
