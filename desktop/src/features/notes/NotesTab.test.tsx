// 메모 탭 (F-06) — 근거: AC-12, CT-13, CT-15, CT-37, EC-07, EC-17,
// notes 쓰기 규칙(FE: 단일 in-flight·baseUpdatedAt·mutation retry 0·자기 409 흡수),
// UI State Contract(notes 저장 상태·1 MiB 사전 검사·409 모달·세션 없음/401 시 미전송 본문 보존·복원)
//
// 접근성 계약(6.2 구현이 유지): 텍스트영역 라벨 "메모", 저장 상태 data-testid="notes-status" 의
// data-state = idle|saving|saved|failed, 409 모달 문구 /다른 기기에서 수정됨/(dialog·alertdialog 무관),
// 버튼 "서버 내용 불러오기" / "내 내용으로 덮어쓰기".
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiClient, Me, Notes, NotesInput } from '@minmo/api-client'

import { useNoteDraftStore } from '../../store/noteDrafts'
import { useSessionStore } from '../../store/session'
import { apiError, createFakeApi, deferred } from '../../test/fakes'
import { makeDeps, makeQueryClient, renderWithDeps } from '../../test/render'
import { NotesTab } from './NotesTab'

const ME_A: Me = { id: 'usr_00000000-0000-0000-0000-00000000000a', githubLogin: 'alice', avatarUrl: null }
const ME_B: Me = { id: 'usr_00000000-0000-0000-0000-00000000000b', githubLogin: 'bob', avatarUrl: null }
const T0 = '2026-11-09T12:00:00.000Z'
const T1 = '2026-11-09T12:00:01.000Z'
const T2 = '2026-11-09T12:00:02.000Z'

type PutCall = [string, string, string, NotesInput]

function setup(o: { notes?: Notes; putNotes?: ApiClient['putNotes'] } = {}) {
  const api = createFakeApi({
    getNotes: async () => o.notes ?? { body: '', updatedAt: null },
    putNotes: o.putNotes ?? (async (_o, _r, _k, input) => ({ body: input.body, updatedAt: T1 })),
  })
  const deps = makeDeps({ api })
  const mount = () => renderWithDeps(<NotesTab owner="MyOrg" repo="Repo-A" issueKey="42" />, deps, makeQueryClient())
  const r = mount()
  const puts = () => api.putNotes.mock.calls as unknown as PutCall[]
  return { api, deps, mount, puts, ...r }
}

const editor = () => screen.findByLabelText('메모')
const status = () => screen.getByTestId('notes-status')
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } })
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', me: ME_A, status: 'online' })
  useNoteDraftStore.setState({ drafts: {} })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('CT-13 메모 없음 → 빈 에디터', () => {
  it('GET {body:"", updatedAt:null} → 빈 값, 저장 요청 없음', async () => {
    const t = setup()
    const el = await editor()
    await waitFor(() => expect(t.api.getNotes).toHaveBeenCalledWith('MyOrg', 'Repo-A', '42'))
    expect(el).toHaveValue('')
    await advance(2000)
    expect(t.api.putNotes).not.toHaveBeenCalled()
  })
})

describe('AC-12 입력 후 1초 정지 → PUT, updatedAt 표시', () => {
  it('1초 전에는 저장하지 않고, 1초 뒤 PUT 1회 (baseUpdatedAt = GET 의 updatedAt)', async () => {
    const t = setup({ notes: { body: 'old', updatedAt: T0 } })
    const el = await editor()
    await waitFor(() => expect(el).toHaveValue('old'))
    type(el, 'old+new')
    await advance(900)
    expect(t.api.putNotes).not.toHaveBeenCalled()
    await advance(200)
    await waitFor(() => expect(t.api.putNotes).toHaveBeenCalledTimes(1))
    expect(t.puts()[0]).toEqual(['MyOrg', 'Repo-A', '42', { body: 'old+new', baseUpdatedAt: T0 }])
    await waitFor(() => expect(status()).toHaveAttribute('data-state', 'saved'))
  })

  it('메모가 없던 이슈의 첫 저장은 baseUpdatedAt: null', async () => {
    const t = setup()
    const el = await editor()
    type(el, 'first')
    await advance(1100)
    await waitFor(() => expect(t.api.putNotes).toHaveBeenCalledTimes(1))
    expect(t.puts()[0][3]).toEqual({ body: 'first', baseUpdatedAt: null })
  })

  it('UTF-8 1 MiB 초과 본문은 전송하지 않고 failed', async () => {
    const t = setup()
    const el = await editor()
    type(el, 'a'.repeat(1_048_577))
    await advance(1100)
    expect(t.api.putNotes).not.toHaveBeenCalled()
    await waitFor(() => expect(status()).toHaveAttribute('data-state', 'failed'))
  })
})

describe('CT-37 단일 in-flight 직렬화', () => {
  it('디바운스 중 연속 입력 3회 → PUT 1회(마지막 본문)', async () => {
    const t = setup()
    const el = await editor()
    type(el, 'a')
    await advance(300)
    type(el, 'ab')
    await advance(300)
    type(el, 'abc')
    await advance(1100)
    await waitFor(() => expect(t.api.putNotes).toHaveBeenCalledTimes(1))
    expect(t.puts()[0][3].body).toBe('abc')
  })

  it('PUT 진행 중 입력은 대기열에 최신본만 → 응답 후 후속 PUT 1회(baseUpdatedAt = 직전 응답 updatedAt)', async () => {
    const first = deferred<Notes>()
    const t = setup({
      putNotes: vi
        .fn<ApiClient['putNotes']>()
        .mockImplementationOnce(() => first.promise)
        .mockImplementation(async (_o, _r, _k, input) => ({ body: input.body, updatedAt: T2 })),
    })
    const el = await editor()
    type(el, 'a')
    await advance(1100)
    await waitFor(() => expect(t.api.putNotes).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(status()).toHaveAttribute('data-state', 'saving'))

    type(el, 'ab')
    await advance(1100)
    type(el, 'abc')
    await advance(1100)
    expect(t.api.putNotes).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve({ body: 'a', updatedAt: T1 })
    })
    await advance(1100)
    await waitFor(() => expect(t.api.putNotes).toHaveBeenCalledTimes(2))
    expect(t.puts()[1][3]).toEqual({ body: 'abc', baseUpdatedAt: T1 })
    await advance(2000)
    expect(t.api.putNotes).toHaveBeenCalledTimes(2)
  })

  it('409 current.body == 내가 보낸 body → 모달 없이 saved, 다음 PUT 은 current.updatedAt 기준', async () => {
    const t = setup({
      putNotes: vi
        .fn<ApiClient['putNotes']>()
        .mockImplementationOnce(async () => {
          throw apiError(409, 'conflict', { current: { body: 'same', updatedAt: T2 } })
        })
        .mockImplementation(async (_o, _r, _k, input) => ({ body: input.body, updatedAt: '2026-11-09T12:00:03.000Z' })),
    })
    const el = await editor()
    type(el, 'same')
    await advance(1100)
    await waitFor(() => expect(status()).toHaveAttribute('data-state', 'saved'))
    expect(screen.queryByText(/다른 기기에서 수정됨/)).toBeNull()

    type(el, 'same+1')
    await advance(1100)
    await waitFor(() => expect(t.api.putNotes).toHaveBeenCalledTimes(2))
    expect(t.puts()[1][3]).toEqual({ body: 'same+1', baseUpdatedAt: T2 })
  })

  it('mutation retry 0 — 실패한 PUT 을 자동 재시도하지 않는다', async () => {
    const t = setup({
      putNotes: async () => {
        throw apiError(400, 'invalid_base_updated_at')
      },
    })
    const el = await editor()
    type(el, 'x')
    await advance(1100)
    await waitFor(() => expect(status()).toHaveAttribute('data-state', 'failed'))
    await advance(5000)
    expect(t.api.putNotes).toHaveBeenCalledTimes(1)
  })
})

describe('CT-15 / EC-07 409 다른 기기 수정 모달', () => {
  const conflictOnce = () =>
    vi
      .fn<ApiClient['putNotes']>()
      .mockImplementationOnce(async () => {
        throw apiError(409, 'conflict', { current: { body: 'server body', updatedAt: T2 } })
      })
      .mockImplementation(async (_o, _r, _k, input) => ({ body: input.body, updatedAt: '2026-11-09T12:00:03.000Z' }))

  it('[서버 내용 불러오기] → 에디터 = 서버 본문(current), 추가 PUT 없음', async () => {
    const t = setup({ notes: { body: 'old', updatedAt: T0 }, putNotes: conflictOnce() })
    const el = await editor()
    await waitFor(() => expect(el).toHaveValue('old'))
    type(el, 'mine')
    await advance(1100)
    expect(await screen.findByText(/다른 기기에서 수정됨/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '서버 내용 불러오기' }))
    await waitFor(() => expect(screen.queryByText(/다른 기기에서 수정됨/)).toBeNull())
    expect(await editor()).toHaveValue('server body')
    await advance(2000)
    expect(t.api.putNotes).toHaveBeenCalledTimes(1)
  })

  it('[내 내용으로 덮어쓰기] → baseUpdatedAt = 서버 updatedAt 으로 재PUT', async () => {
    const t = setup({ notes: { body: 'old', updatedAt: T0 }, putNotes: conflictOnce() })
    const el = await editor()
    await waitFor(() => expect(el).toHaveValue('old'))
    type(el, 'mine')
    await advance(1100)
    await screen.findByText(/다른 기기에서 수정됨/)
    fireEvent.click(screen.getByRole('button', { name: '내 내용으로 덮어쓰기' }))
    await waitFor(() => expect(t.api.putNotes).toHaveBeenCalledTimes(2))
    expect(t.puts()[1][3]).toEqual({ body: 'mine', baseUpdatedAt: T2 })
    await waitFor(() => expect(status()).toHaveAttribute('data-state', 'saved'))
  })
})

describe('EC-17 서버 미연결 → 메모 편집 비활성(읽기 캐시 표시)', () => {
  it('status offline 이면 에디터 비활성', async () => {
    useSessionStore.setState({ status: 'offline' })
    setup({ notes: { body: 'cached', updatedAt: T0 } })
    const el = await editor()
    await waitFor(() => expect(el).toHaveValue('cached'))
    expect(el).toBeDisabled()
  })
})

describe('UI State "세션 없음/401" — 미전송 본문 보존·같은 사용자 재로그인 시 복원', () => {
  const unauthorized = async (): Promise<Notes> => {
    throw apiError(401, 'unauthorized')
  }

  it('PUT 401 → 세션 삭제, 같은 사용자로 재로그인하면 미전송 본문 복원', async () => {
    const t = setup({ notes: { body: 'server', updatedAt: T0 }, putNotes: unauthorized })
    const el = await editor()
    await waitFor(() => expect(el).toHaveValue('server'))
    type(el, 'unsent')
    await advance(1100)
    await waitFor(() => expect(t.api.putNotes).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useSessionStore.getState().token).toBeNull())
    t.unmount()

    act(() => {
      useSessionStore.setState({ token: 'tok2', me: ME_A })
    })
    t.mount()
    const el2 = await editor()
    await waitFor(() => expect(el2).toHaveValue('unsent'))
  })

  it('다른 사용자로 로그인하면 보존 본문 폐기 → 서버 본문 표시', async () => {
    const t = setup({ notes: { body: 'server', updatedAt: T0 }, putNotes: unauthorized })
    const el = await editor()
    await waitFor(() => expect(el).toHaveValue('server'))
    type(el, 'unsent')
    await advance(1100)
    await waitFor(() => expect(t.api.putNotes).toHaveBeenCalledTimes(1))
    t.unmount()

    act(() => {
      useSessionStore.setState({ token: 'tok-b', me: ME_B })
    })
    t.mount()
    const el2 = await editor()
    await waitFor(() => expect(el2).toHaveValue('server'))
    await advance(1100)
    expect(t.api.putNotes).toHaveBeenCalledTimes(1)
  })

  it('디바운스 대기 중 세션이 끊기면(전송 전) 그 본문을 보존해 같은 사용자 재로그인 시 복원', async () => {
    const t = setup({ notes: { body: 'server', updatedAt: T0 } })
    const el = await editor()
    await waitFor(() => expect(el).toHaveValue('server'))
    type(el, 'pending')
    await advance(300)
    act(() => {
      useSessionStore.setState({ token: null, me: null })
    })
    t.unmount()

    act(() => {
      useSessionStore.setState({ token: 'tok2', me: ME_A })
    })
    t.mount()
    const el2 = await editor()
    await waitFor(() => expect(el2).toHaveValue('pending'))
  })
})
