// 내장 서버 — 서버 설정·시작 화면·창 닫기·상태 구독·포트 연동
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { OfflineBanner } from '../../components/OfflineBanner'
import { portOf, serverBaseUrl } from '../../lib/api'
import type { ServerSettings, ServerStatus, TauriApi, UpdateInfo } from '../../lib/tauri'
import { useServerStore } from '../../store/server'
import { useSessionStore } from '../../store/session'
import { useUpdateStore } from '../../store/update'
import { SERVER_SETTINGS, createFakeTauri, deferred, flush } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { CloseDialog } from '../app/CloseDialog'
import { sshConfigExample, sshWindowsNote } from '../cli/sshConfig'
import { ServerSettingsDialog, ServerSettingsForm } from './ServerSettingsDialog'
import { ServerStartScreen } from './ServerStartScreen'
import { parsePort, statusText } from './serverSettings'
import { useServerStatusSubscription } from './useServerStatus'

const running: ServerStatus = { state: 'running', port: 8787, message: null }

beforeEach(() => {
  useServerStore.setState(useServerStore.getInitialState(), true)
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useUpdateStore.setState(useUpdateStore.getInitialState(), true)
})

describe('helpers', () => {
  it('parsePort: 1024~65535 정수만', () => {
    expect(parsePort('8787')).toBe(8787)
    expect(parsePort(' 18787 ')).toBe(18787)
    for (const bad of ['80', '65536', '87a', '', '8787.5', '-1']) expect(parsePort(bad)).toBeNull()
  })

  it('statusText', () => {
    expect(statusText(running)).toBe('실행 중 · 127.0.0.1:8787')
    expect(statusText({ state: 'failed', port: 1, message: '포트 사용 중' })).toContain('포트 사용 중')
    expect(statusText(null)).toBe('확인 중…')
  })

  it('API 주소·SSH 안내가 설정된 포트를 따른다', () => {
    expect(serverBaseUrl(18787)).toBe('http://127.0.0.1:18787')
    expect(portOf('http://127.0.0.1:18787')).toBe(18787)
    expect(portOf(null)).toBe(8787)
    expect(sshConfigExample(18787)).toContain('RemoteForward /home/<사용자>/.minmo/server.sock 127.0.0.1:18787')
    expect(sshWindowsNote(18787)).toContain('RemoteForward 127.0.0.1:18787 127.0.0.1:18787')
  })

  it('앱이 서버 주소를 알려 주면(배포 빌드) 내장 서버 포트 대신 그 주소를 쓴다', () => {
    expect(serverBaseUrl(8787, 'https://minmo.example')).toBe('https://minmo.example')
    expect(serverBaseUrl(18787, null)).toBe('http://127.0.0.1:18787')
    expect(statusText({ state: 'external', port: 8787, message: null, url: 'https://minmo.example' })).toBe('연결됨 · https://minmo.example')
    expect(statusText({ state: 'external', port: 8787, message: null })).toContain('외부 서버')
  })
})

describe('ServerSettingsDialog', () => {
  function open(settings = SERVER_SETTINGS) {
    const fake = createFakeTauri({ serverSettingsGet: async () => settings })
    useServerStore.setState({ status: running, settingsOpen: true })
    render(<ServerSettingsDialog tauri={fake.tauri} />)
    return { tauri: fake.tauri }
  }

  it('서버 상태와 포트·닫기 동작만 다룬다 — OAuth App(Client ID·Secret) 항목은 없다', async () => {
    open()
    expect(await screen.findByLabelText('포트')).toHaveValue('8787')
    expect(screen.getByTestId('server-status')).toHaveTextContent('실행 중 · 127.0.0.1:8787')
    expect(screen.queryByLabelText('Client ID')).toBeNull()
    expect(screen.queryByLabelText('Client Secret')).toBeNull()
    expect(screen.queryByText(/OAuth App/)).toBeNull()
  })

  it('내장 서버를 쓰지 않으면(배포 빌드) 서버 주소만 보여 주고 포트·다시 시작·로그는 숨긴다', async () => {
    const fake = createFakeTauri({ serverSettingsGet: async () => SERVER_SETTINGS })
    useServerStore.setState({ status: { state: 'external', port: 8787, message: null, url: 'https://minmo.example' }, settingsOpen: true })
    render(<ServerSettingsDialog tauri={fake.tauri} />)
    expect(await screen.findByTestId('server-status')).toHaveTextContent('연결됨 · https://minmo.example')
    expect(screen.queryByLabelText('포트')).toBeNull()
    expect(screen.queryByRole('button', { name: '다시 시작' })).toBeNull()
    expect(screen.queryByRole('button', { name: '로그 폴더 열기' })).toBeNull()
  })

  it('바뀐 값만 저장하고 닫는다', async () => {
    const { tauri } = open()
    fireEvent.click(await screen.findByLabelText('트레이로 최소화(서버 유지)'))
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(useServerStore.getState().settingsOpen).toBe(false))
    expect(tauri.serverSettingsSave).toHaveBeenCalledWith({ closeAction: 'tray' })
  })

  it('포트를 바꾸면 안내가 뜨고 새 포트를 저장한다', async () => {
    const { tauri } = open()
    fireEvent.change(await screen.findByLabelText('포트'), { target: { value: '18787' } })
    expect(screen.getByText(/새 포트로 다시 시작하고 다시 연결합니다/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(useServerStore.getState().settingsOpen).toBe(false))
    expect(tauri.serverSettingsSave).toHaveBeenCalledWith({ port: 18787 })
  })

  it('잘못된 포트는 저장하지 않는다', async () => {
    const { tauri } = open()
    fireEvent.change(await screen.findByLabelText('포트'), { target: { value: '80' } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('1024~65535')
    expect(tauri.serverSettingsSave).not.toHaveBeenCalled()
  })

  it('저장 실패를 보여 준다', async () => {
    const fake = createFakeTauri({
      serverSettingsGet: async () => SERVER_SETTINGS,
      serverSettingsSave: async () => {
        throw new Error('키체인 오류')
      },
    })
    useServerStore.setState({ status: running, settingsOpen: true })
    render(<ServerSettingsDialog tauri={fake.tauri} />)
    fireEvent.change(await screen.findByLabelText('포트'), { target: { value: '18787' } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('키체인 오류')
    expect(useServerStore.getState().settingsOpen).toBe(true)
  })

  it('AC-15 서버·앱 항목만 다룬다 — 글자 크기·에이전트 알림·AI 사용량은 없다', async () => {
    open()
    expect(await screen.findByLabelText('포트')).toBeInTheDocument()
    const dialog = screen.getByRole('dialog', { name: '서버 설정' })
    expect(within(dialog).getByRole('button', { name: '업데이트 확인' })).toBeInTheDocument()
    expect(within(dialog).getByRole('radiogroup', { name: '창을 닫을 때' })).toBeInTheDocument()
    expect(within(dialog).queryAllByRole('spinbutton')).toHaveLength(0)
    expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(0)
    expect(within(dialog).queryAllByText(/글자 크기/)).toHaveLength(0)
    expect(within(dialog).queryAllByText(/에이전트 알림/)).toHaveLength(0)
    expect(within(dialog).queryAllByText(/AI 사용량/)).toHaveLength(0)
  })
})

describe('ServerSettingsForm — 설정 화면(onDone 없음)', () => {
  const NEXT: UpdateInfo = { version: '0.4.1', currentVersion: '0.4.0', notes: null, date: null }

  /** onDone 없이 띄운다. 저장은 받은 값을 반영한 설정을 돌려준다(lib/tauri.mock.ts 의 serverSettingsSave 와 같은 방식) */
  function page(overrides: Partial<TauriApi> = {}) {
    let current: ServerSettings = SERVER_SETTINGS
    const fake = createFakeTauri({
      serverSettingsGet: async () => current,
      serverSettingsSave: async (input) => {
        current = { ...current, ...input }
        return current
      },
      ...overrides,
    })
    useServerStore.setState({ status: running })
    render(<ServerSettingsForm tauri={fake.tauri} />)
    return { tauri: fake.tauri }
  }

  it('AC-14 창 닫기만 바꿔 저장하면 저장했습니다 — 이후 비교는 serverSettingsSave 가 돌려준 값 기준', async () => {
    const { tauri } = page()
    fireEvent.click(await screen.findByLabelText('트레이로 최소화(서버 유지)'))
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    expect((await screen.findByText('저장했습니다')).closest('[role="status"]')).not.toBeNull()
    expect(tauri.serverSettingsSave).toHaveBeenCalledWith({ closeAction: 'tray' })
    // 돌려받은 값이 새 기준 — 그대로 다시 [저장] 하면 저장하지 않는다
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await flush()
    expect(tauri.serverSettingsSave).toHaveBeenCalledTimes(1)
    // 처음 값(매번 묻기)으로 되돌리면 바뀐 값으로 본다
    fireEvent.click(screen.getByLabelText('매번 묻기'))
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(tauri.serverSettingsSave).toHaveBeenCalledTimes(2))
    expect(tauri.serverSettingsSave).toHaveBeenLastCalledWith({ closeAction: 'ask' })
  })

  it('AC-14 바뀐 값이 없으면 [저장] 은 아무것도 하지 않는다', async () => {
    const { tauri } = page()
    fireEvent.click(await screen.findByRole('button', { name: '저장' }))
    await flush()
    expect(tauri.serverSettingsSave).not.toHaveBeenCalled()
    expect(screen.queryByText('저장했습니다')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText('포트')).toHaveValue('8787')
  })

  it('EC-28 저장 중에는 [저장] 이 disabled, 저장하면 포커스를 [저장] 으로 되돌린다', async () => {
    const save = deferred<ServerSettings>()
    const { tauri } = page({ serverSettingsSave: () => save.promise })
    fireEvent.click(await screen.findByLabelText('트레이로 최소화(서버 유지)'))
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '저장' })).not.toHaveFocus()
    await act(async () => save.resolve({ ...SERVER_SETTINGS, closeAction: 'tray' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toHaveFocus())
    expect(screen.getByRole('button', { name: '저장' })).toBeEnabled()
    expect(tauri.serverSettingsSave).toHaveBeenCalledTimes(1)
  })

  it('EC-31 [업데이트 확인] 결과 새 버전이 있으면 설정을 닫은 뒤 화면 위 안내에서 설치하라고 알린다', async () => {
    page({ appUpdateCheck: async () => NEXT })
    fireEvent.click(await screen.findByRole('button', { name: '업데이트 확인' }))
    expect(await screen.findByText('새 버전 v0.4.1 이 있습니다 — 설정을 닫으면 화면 위 안내에서 설치할 수 있습니다')).toBeInTheDocument()
  })
})

describe('ServerStartScreen', () => {
  it('시작 중이면 대기 표시 + [서버 설정]·[로그 폴더 열기](오래 걸릴 때)', () => {
    const { tauri } = createFakeTauri()
    render(<ServerStartScreen status={{ state: 'starting', port: 8787, message: null }} tauri={tauri} />)
    expect(screen.getByTestId('server-starting')).toHaveTextContent('서버 시작 중')
    fireEvent.click(screen.getByRole('button', { name: '서버 설정' }))
    expect(useServerStore.getState().settingsOpen).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '로그 폴더 열기' }))
    expect(tauri.serverOpenLogDir).toHaveBeenCalled()
  })

  it('실패하면 원인과 [다시 시작]·[서버 설정]·[로그 폴더 열기]', () => {
    const { tauri } = createFakeTauri()
    render(<ServerStartScreen status={{ state: 'failed', port: 8787, message: '포트 8787 을(를) 다른 프로그램이 쓰고 있습니다' }} tauri={tauri} />)
    expect(screen.getByTestId('server-failed')).toHaveTextContent('포트 8787')
    fireEvent.click(screen.getByRole('button', { name: '다시 시작' }))
    expect(tauri.serverRestart).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '로그 폴더 열기' }))
    expect(tauri.serverOpenLogDir).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '서버 설정' }))
    expect(useServerStore.getState().settingsOpen).toBe(true)
  })
})

describe('CloseDialog', () => {
  it('닫기 요청 → 선택(다음부터 묻지 않기 포함)을 전달한다', async () => {
    const fake = createFakeTauri()
    render(<CloseDialog tauri={fake.tauri} />)
    await waitFor(() => expect(fake.tauri.onCloseRequested).toHaveBeenCalled())
    act(() => fake.emitCloseRequested())
    expect(await screen.findByRole('dialog', { name: '창을 닫을까요?' })).toBeVisible()
    fireEvent.click(screen.getByLabelText(/다음부터 묻지 않기/))
    fireEvent.click(screen.getByRole('button', { name: '종료' }))
    expect(fake.tauri.appClose).toHaveBeenCalledWith('quit', true)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('[취소]는 아무것도 하지 않는다', async () => {
    const fake = createFakeTauri()
    render(<CloseDialog tauri={fake.tauri} />)
    await waitFor(() => expect(fake.tauri.onCloseRequested).toHaveBeenCalled())
    act(() => fake.emitCloseRequested())
    fireEvent.click(await screen.findByRole('button', { name: '취소' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fake.tauri.appClose).not.toHaveBeenCalled()
  })
})

describe('useServerStatusSubscription', () => {
  it('구독이 등록된 뒤에 현재 상태를 읽는다', async () => {
    let registered: () => void = () => {}
    const fake = createFakeTauri({ onServerStatus: () => new Promise((r) => (registered = () => r(() => {}))) })
    renderHook(() => useServerStatusSubscription(fake.tauri))
    await waitFor(() => expect(fake.tauri.onServerStatus).toHaveBeenCalled())
    expect(fake.tauri.serverStatus).not.toHaveBeenCalled()
    await act(async () => registered())
    expect(fake.tauri.serverStatus).toHaveBeenCalled()
  })

  it('구독 후 도착한 이벤트가 늦게 끝난 조회 결과보다 우선한다', async () => {
    let resolveStatus: (s: ServerStatus) => void = () => {}
    const fake = createFakeTauri({ serverStatus: () => new Promise((r) => (resolveStatus = r)) })
    const { result } = renderHook(() => useServerStatusSubscription(fake.tauri))
    await waitFor(() => expect(fake.tauri.onServerStatus).toHaveBeenCalled())
    act(() => fake.emitServerStatus(running))
    await act(async () => resolveStatus({ state: 'starting', port: 8787, message: null }))
    expect(result.current).toEqual(running)
  })

  it('조회 실패는 failed 로 보여 준다', async () => {
    const fake = createFakeTauri({
      serverStatus: async () => {
        throw new Error('invoke 실패')
      },
    })
    const { result } = renderHook(() => useServerStatusSubscription(fake.tauri))
    await waitFor(() => expect(result.current?.state).toBe('failed'))
    expect(result.current?.message).toContain('invoke 실패')
  })
})

describe('OfflineBanner — 내장 서버 정지', () => {
  it('서버가 멈추면 원인 첫 줄과 [다시 시작]을 보여 준다', () => {
    const fake = createFakeTauri()
    useServerStore.setState({ status: { state: 'failed', port: 8787, message: '서버가 종료되었습니다(exit code: 1).\nlevel=ERROR ...' } })
    renderWithDeps(<OfflineBanner />, makeDeps({ tauri: fake.tauri }))
    const banner = screen.getByTestId('server-down-banner')
    expect(banner).toHaveTextContent('서버가 멈췄습니다 — 서버가 종료되었습니다(exit code: 1).')
    expect(banner).not.toHaveTextContent('level=ERROR')
    fireEvent.click(screen.getByRole('button', { name: '다시 시작' }))
    expect(fake.tauri.serverRestart).toHaveBeenCalled()
    expect(screen.queryByTestId('offline-banner')).toBeNull()
  })
})
