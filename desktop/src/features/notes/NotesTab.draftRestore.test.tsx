// RF-01 — 401 등으로 보존한 메모 초안의 복원 PUT 은 "초안 작성 당시 알던 updatedAt" 을 base 로 쓴다.
// 근거: CT-15·CT-37, 계약 "notes 쓰기 규칙(FE)"(baseUpdatedAt = 직전에 알던 updatedAt),
// UI State "세션 없음/401"(같은 사용자 재로그인 시 복원) + "notes 409"(다른 기기에서 수정됨 모달).
// 재로그인 후 새로 GET 한 updatedAt 을 base 로 쓰면 그 사이 다른 기기의 수정을 조용히 덮어쓴다(데이터 손실).
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiClient, Me, Notes, NotesInput } from '@minmo/api-client'

import { useNoteDraftStore } from '../../store/noteDrafts'
import { useSessionStore } from '../../store/session'
import { apiError, createFakeApi } from '../../test/fakes'
import { makeDeps, makeQueryClient, renderWithDeps } from '../../test/render'
import { NotesTab } from './NotesTab'

const ME_A: Me = { id: 'usr_00000000-0000-0000-0000-00000000000a', githubLogin: 'alice', avatarUrl: null }
const T0 = '2026-11-09T12:00:00.000Z'
const T2 = '2026-11-09T12:00:02.000Z'
const T3 = '2026-11-09T12:00:03.000Z'

type PutCall = [string, string, string, NotesInput]

/** 계약 E14 의 baseUpdatedAt 3분기(생략·null·문자열)를 따르는 인메모리 서버 */
function fakeServer(initial: Notes) {
  const s = { current: { ...initial }, nextUpdatedAt: T3, unauthorized: false }
  const putNotes: ApiClient['putNotes'] = async (_o, _r, _k, input) => {
    if (s.unauthorized) throw apiError(401, 'unauthorized')
    const cur = s.current
    const base = input.baseUpdatedAt
    const ok = base === undefined || (base === null ? cur.updatedAt === null : base === cur.updatedAt)
    if (!ok) throw apiError(409, 'conflict', { current: { ...cur } })
    s.current = { body: input.body, updatedAt: s.nextUpdatedAt }
    return { ...s.current }
  }
  return {
    s,
    /** 다른 기기가 저장한 것처럼 서버 값을 바꾼다 */
    editElsewhere(body: string, updatedAt: string) {
      s.current = { body, updatedAt }
    },
    api: createFakeApi({ getNotes: async () => ({ ...s.current }), putNotes }),
  }
}

function setup(initial: Notes) {
  const server = fakeServer(initial)
  const deps = makeDeps({ api: server.api })
  const mount = () => renderWithDeps(<NotesTab owner="MyOrg" repo="Repo-A" issueKey="42" />, deps, makeQueryClient())
  const r = mount()
  const puts = () => server.api.putNotes.mock.calls as unknown as PutCall[]
  return { ...server, mount, puts, ...r }
}

const editor = () => screen.findByLabelText('메모')
const status = () => screen.getByTestId('notes-status')
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } })
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
const relogin = () =>
  act(() => {
    useSessionStore.setState({ token: 'tok2', me: ME_A })
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

describe('RF-01 초안 복원 PUT 의 baseUpdatedAt = 초안 작성 당시 updatedAt', () => {
  /** PUT 401 로 'unsent' 초안을 base T0 와 함께 보존하고 언마운트 */
  async function loseSessionWithDraft(t: ReturnType<typeof setup>) {
    const el = await editor()
    await waitFor(() => expect(el).toHaveValue('server'))
    t.s.unauthorized = true
    type(el, 'unsent')
    await advance(1100)
    await waitFor(() => expect(useSessionStore.getState().token).toBeNull())
    t.unmount()
    t.s.unauthorized = false
  }

  it('PUT 401 로 보존한 초안에 당시 base(T0)가 함께 저장된다', async () => {
    const t = setup({ body: 'server', updatedAt: T0 })
    await loseSessionWithDraft(t)
    expect(Object.values(useNoteDraftStore.getState().drafts)).toEqual([{ body: 'unsent', baseUpdatedAt: T0 }])
  })

  it('재로그인 사이 다른 기기가 수정했으면 복원 PUT 은 옛 base(T0)로 나가 409 → 모달, 서버 본문은 보존', async () => {
    const t = setup({ body: 'server', updatedAt: T0 })
    await loseSessionWithDraft(t)
    t.editElsewhere('other device', T2)

    relogin()
    t.mount()
    const el = await editor()
    await waitFor(() => expect(el).toHaveValue('unsent'))
    await advance(1100)

    await waitFor(() => expect(t.puts()).toHaveLength(2))
    // 새로 GET 한 T2 가 아니라 초안 작성 당시의 T0
    expect(t.puts()[1][3]).toEqual({ body: 'unsent', baseUpdatedAt: T0 })
    expect(await screen.findByText(/다른 기기에서 수정됨/)).toBeInTheDocument()
    expect(t.s.current).toEqual({ body: 'other device', updatedAt: T2 })
    await waitFor(() => expect(status()).toHaveAttribute('data-state', 'failed'))
  })

  it('모달에서 [내 내용으로 덮어쓰기] → 서버 updatedAt(T2)을 base 로 재PUT 해 저장', async () => {
    const t = setup({ body: 'server', updatedAt: T0 })
    await loseSessionWithDraft(t)
    t.editElsewhere('other device', T2)

    relogin()
    t.mount()
    await advance(1100)
    await screen.findByText(/다른 기기에서 수정됨/)
    fireEvent.click(screen.getByRole('button', { name: '내 내용으로 덮어쓰기' }))

    await waitFor(() => expect(t.puts()).toHaveLength(3))
    expect(t.puts()[2][3]).toEqual({ body: 'unsent', baseUpdatedAt: T2 })
    await waitFor(() => expect(status()).toHaveAttribute('data-state', 'saved'))
    expect(t.s.current).toEqual({ body: 'unsent', updatedAt: T3 })
  })

  it('모달에서 [서버 내용 불러오기] → 다른 기기 본문 표시, 추가 PUT 없음', async () => {
    const t = setup({ body: 'server', updatedAt: T0 })
    await loseSessionWithDraft(t)
    t.editElsewhere('other device', T2)

    relogin()
    t.mount()
    await advance(1100)
    await screen.findByText(/다른 기기에서 수정됨/)
    fireEvent.click(screen.getByRole('button', { name: '서버 내용 불러오기' }))

    expect(await editor()).toHaveValue('other device')
    await advance(2000)
    expect(t.puts()).toHaveLength(2)
    expect(t.s.current).toEqual({ body: 'other device', updatedAt: T2 })
  })

  it('그 사이 서버가 바뀌지 않았으면 복원 PUT(base T0)이 그대로 저장되고 모달 없음', async () => {
    const t = setup({ body: 'server', updatedAt: T0 })
    await loseSessionWithDraft(t)

    relogin()
    t.mount()
    await advance(1100)

    await waitFor(() => expect(status()).toHaveAttribute('data-state', 'saved'))
    expect(t.puts()[1][3]).toEqual({ body: 'unsent', baseUpdatedAt: T0 })
    expect(screen.queryByText(/다른 기기에서 수정됨/)).toBeNull()
    expect(t.s.current).toEqual({ body: 'unsent', updatedAt: T3 })
  })

  it('메모가 없던 이슈(base null)에서 디바운스 중 세션이 끊긴 초안 → 그 사이 다른 기기가 만들었으면 base null 로 409', async () => {
    const t = setup({ body: '', updatedAt: null })
    const el = await editor()
    type(el, 'pending')
    await advance(300)
    act(() => {
      useSessionStore.setState({ token: null, me: null })
    })
    t.unmount()
    expect(Object.values(useNoteDraftStore.getState().drafts)).toEqual([{ body: 'pending', baseUpdatedAt: null }])
    t.editElsewhere('created elsewhere', T2)

    relogin()
    t.mount()
    const el2 = await editor()
    await waitFor(() => expect(el2).toHaveValue('pending'))
    await advance(1100)

    await waitFor(() => expect(t.puts()).toHaveLength(1))
    expect(t.puts()[0][3]).toEqual({ body: 'pending', baseUpdatedAt: null })
    expect(await screen.findByText(/다른 기기에서 수정됨/)).toBeInTheDocument()
    expect(t.s.current).toEqual({ body: 'created elsewhere', updatedAt: T2 })
  })
})
