// 내장 서버 — 서버 설정·시작 화면·창 닫기·상태 구독·포트 연동
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { OfflineBanner } from '../../components/OfflineBanner'
import { portOf, serverBaseUrl } from '../../lib/api'
import type { ServerStatus } from '../../lib/tauri'
import { useServerStore } from '../../store/server'
import { useSessionStore } from '../../store/session'
import { SERVER_SETTINGS, createFakeTauri } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { CloseDialog } from '../app/CloseDialog'
import { sshConfigExample, sshWindowsNote } from '../cli/sshConfig'
import { ServerSettingsDialog } from './ServerSettingsDialog'
import { ServerStartScreen } from './ServerStartScreen'
import { parsePort, statusText } from './serverSettings'
import { useServerStatusSubscription } from './useServerStatus'

const running: ServerStatus = { state: 'running', port: 8787, message: null }

beforeEach(() => {
  useServerStore.setState(useServerStore.getInitialState(), true)
  useSessionStore.setState(useSessionStore.getInitialState(), true)
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
})

describe('ServerSettingsDialog', () => {
  function open(settings = SERVER_SETTINGS) {
    const fake = createFakeTauri({ serverSettingsGet: async () => settings })
    useServerStore.setState({ status: running, settingsOpen: true })
    render(<ServerSettingsDialog tauri={fake.tauri} />)
    return { tauri: fake.tauri }
  }

  it('상태·callback URL 을 보여 주고, Secret 은 저장 여부만 표시한다', async () => {
    open({ ...SERVER_SETTINGS, githubClientId: 'Iv1.x', hasClientSecret: true })
    expect(await screen.findByLabelText('Client ID')).toHaveValue('Iv1.x')
    expect(screen.getByTestId('server-status')).toHaveTextContent('실행 중 · 127.0.0.1:8787')
    expect(screen.getByTestId('callback-url')).toHaveTextContent('http://127.0.0.1:8787/auth/github/callback')
    const secret = screen.getByLabelText('Client Secret')
    expect(secret).toHaveValue('')
    expect(secret).toHaveAttribute('type', 'password')
    expect(secret).toHaveAttribute('placeholder', expect.stringContaining('저장됨'))
  })

  it('바뀐 값만 저장하고 닫는다(빈 Secret 은 보내지 않음)', async () => {
    const { tauri } = open()
    fireEvent.change(await screen.findByLabelText('Client ID'), { target: { value: '  Iv1.new ' } })
    fireEvent.click(screen.getByLabelText('트레이로 최소화(서버 유지)'))
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(useServerStore.getState().settingsOpen).toBe(false))
    expect(tauri.serverSettingsSave).toHaveBeenCalledWith({ githubClientId: 'Iv1.new', closeAction: 'tray' })
  })

  it('Secret 을 입력하면 보낸다', async () => {
    const { tauri } = open()
    fireEvent.change(await screen.findByLabelText('Client Secret'), { target: { value: 'sec ' } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(tauri.serverSettingsSave).toHaveBeenCalledWith({ githubClientSecret: 'sec' }))
  })

  it('포트를 바꾸면 callback URL·안내가 따라 바뀌고 새 포트를 저장한다', async () => {
    const { tauri } = open()
    fireEvent.change(await screen.findByLabelText('포트'), { target: { value: '18787' } })
    expect(screen.getByTestId('callback-url')).toHaveTextContent('http://127.0.0.1:18787/auth/github/callback')
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
    fireEvent.change(await screen.findByLabelText('Client ID'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('키체인 오류')
    expect(useServerStore.getState().settingsOpen).toBe(true)
  })

  it('[GitHub 에서 OAuth App 등록]은 등록 페이지를 연다', async () => {
    const { tauri } = open()
    fireEvent.click(await screen.findByRole('button', { name: /OAuth App 등록/ }))
    expect(tauri.openUrl).toHaveBeenCalledWith('https://github.com/settings/applications/new')
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
