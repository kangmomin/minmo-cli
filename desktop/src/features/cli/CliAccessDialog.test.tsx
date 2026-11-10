// 원격 CLI 접속 다이얼로그 — 1회용 코드 발급·남은 시간·명령 복사, SSH 설정 예시, 세션 목록·끊기
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Sessions } from '@minmo/api-client'

import { useSessionStore } from '../../store/session'
import { createFakeApi } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { CliAccessDialog } from './CliAccessDialog'

const SESSIONS: Sessions = {
  sessions: [
    { id: 's-cli', kind: 'cli', label: 'devbox', createdAt: '2026-11-10T00:00:01.000Z', lastUsedAt: '2026-11-10T00:00:02.000Z', current: false },
    { id: 's-desk', kind: 'desktop', label: null, createdAt: '2026-11-10T00:00:00.000Z', lastUsedAt: '2026-11-10T00:00:02.000Z', current: true },
  ],
}

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
})

afterEach(() => {
  vi.useRealTimers()
})

function setup() {
  let sessions = SESSIONS
  const api = createFakeApi({
    issueCliCode: async () => ({ code: 'ABCD-EFGH', expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }),
    listSessions: async () => sessions,
    revokeSession: async (id) => {
      sessions = { sessions: sessions.sessions.filter((s) => s.id !== id) }
    },
  })
  renderWithDeps(<CliAccessDialog open onOpenChange={() => {}} />, makeDeps({ api }))
  return { api, user: userEvent.setup() }
}

describe('원격 CLI 접속', () => {
  it('코드를 발급하면 코드·남은 시간을 보여 주고 `minmo login <코드>` 를 복사한다', async () => {
    const { api, user } = setup()
    await user.click(screen.getByRole('button', { name: '코드 발급' }))
    expect(await screen.findByTestId('cli-code')).toHaveTextContent('ABCD-EFGH')
    expect(screen.getByText(/10:00 남음|9:5\d 남음/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '명령 복사' }))
    // user-event 가 navigator.clipboard 를 가짜로 바꿔 두므로 읽어서 확인한다
    expect(await navigator.clipboard.readText()).toBe('minmo login ABCD-EFGH')
    expect(screen.getByRole('status')).toHaveTextContent('로그인 명령을 복사했습니다')
    expect(api.issueCliCode).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '새 코드 발급' })).toBeInTheDocument()
  })

  it('만료되면 코드를 숨기고 다시 발급하라고 안내한다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: '코드 발급' }))
    await screen.findByTestId('cli-code')
    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1000 + 1000)
    })
    expect(screen.queryByTestId('cli-code')).toBeNull()
    expect(screen.getByText(/코드가 만료됐습니다/)).toBeInTheDocument()
  })

  it('SSH 설정 예시는 Unix 소켓 역터널을 쓴다', () => {
    setup()
    const pre = screen.getByTestId('ssh-config')
    expect(pre).toHaveTextContent('RemoteForward /home/<사용자>/.minmo/server.sock 127.0.0.1:8787')
    // 남은 소켓이 있으면 ExitOnForwardFailure 는 접속 자체를 막으므로 넣지 않는다
    expect(pre).not.toHaveTextContent('ExitOnForwardFailure')
    expect(screen.getByText(/StreamLocalBindUnlink yes/)).toBeInTheDocument()
  })

  it('세션 목록 — 이 기기는 끊기 없음, CLI 세션은 끊으면 목록에서 빠진다', async () => {
    const { api, user } = setup()
    const list = await screen.findByText('devbox')
    expect(screen.getByText('이 기기')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '데스크탑 세션 끊기' })).toBeNull()
    await user.click(within(list.closest('li')!).getByRole('button', { name: 'devbox 세션 끊기' }))
    await waitFor(() => expect(api.revokeSession).toHaveBeenCalledWith('s-cli'))
    await waitFor(() => expect(screen.queryByText('devbox')).toBeNull())
    expect(screen.getByRole('status')).toHaveTextContent('devbox 세션을 끊었습니다')
  })
})
