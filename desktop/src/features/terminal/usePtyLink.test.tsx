// 원격 터미널의 연결 상태(pty-link)를 패널 하나에 맞춰 받는 훅(#89)
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PtyLink, PtyLinkEvent, TauriApi } from '../../lib/tauri'
import { usePtyLink } from './usePtyLink'

const link = (o: Partial<PtyLink> = {}): PtyLink => ({ phase: 'waiting', attempt: 1, max: 5, seq: 1, reason: null, at: null, ...o })
const ev = (id: string, o: Partial<PtyLink> = {}): PtyLinkEvent => ({ id, ...link(o) })

/** 이벤트를 테스트에서 직접 넣을 수 있는 onPtyLink */
function source() {
  const cbs = new Set<(e: PtyLinkEvent) => void>()
  const tauri: Pick<TauriApi, 'onPtyLink'> = {
    onPtyLink: vi.fn(async (cb: (e: PtyLinkEvent) => void) => {
      cbs.add(cb)
      return () => void cbs.delete(cb)
    }),
  }
  return { tauri, emit: (e: PtyLinkEvent) => act(() => cbs.forEach((cb) => cb(e))) }
}

/** 구독까지 마친 훅 */
async function attached() {
  const s = source()
  const r = renderHook(() => usePtyLink(s.tauri))
  await act(async () => {
    await r.result.current.attach()
  })
  return { ...r, emit: s.emit }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('usePtyLink', () => {
  // AC-09 — 구독 뒤 id 가 정해지기 전(ptyFind 를 기다리는 동안)에 온 상태도 놓치지 않는다
  it('구독한 뒤 id 가 정해지기 전에 온 이벤트도 id 가 정해지면 반영한다', async () => {
    const h = await attached()
    h.emit(ev('pty-1', { phase: 'waiting', attempt: 1, seq: 3 }))
    act(() => h.result.current.setId('pty-1'))
    expect(h.result.current.link).toMatchObject({ phase: 'waiting', attempt: 1, seq: 3 })
    expect(h.result.current.linkRef.current).toMatchObject({ phase: 'waiting', attempt: 1 })
  })

  // AC-09 — ptyFind 의 지금 상태(snapshot)와 그 사이에 온 이벤트 중 더 새것(seq 가 큰 쪽)을 쓴다
  it.each([
    ['이벤트가 더 새것', 5, 4, { phase: 'connecting', attempt: 2 }],
    ['스냅샷이 더 새것', 3, 4, { phase: 'waiting', attempt: 2 }],
  ] as const)('스냅샷과 먼저 온 이벤트 중 seq 가 큰 쪽을 쓴다 — %s', async (_, eventSeq, snapSeq, expected) => {
    const h = await attached()
    h.emit(ev('pty-1', { phase: 'connecting', attempt: 2, seq: eventSeq }))
    act(() => h.result.current.setId('pty-1', link({ phase: 'waiting', attempt: 2, seq: snapSeq })))
    expect(h.result.current.link).toMatchObject(expected)
  })

  // AC-09 — 터미널 화면을 다시 만들며 다시 구독할 때도(이전 id 가 남아 있어도) 그 사이의 이벤트를 놓치지 않는다
  it('이전 id 가 있던 채로 다시 attach 해도 setId 전에 온 이벤트를 id 가 정해지면 반영한다', async () => {
    const h = await attached()
    act(() => h.result.current.setId('pty-1'))
    h.emit(ev('pty-1', { phase: 'failed', attempt: 5, seq: 4 }))
    await act(async () => {
      await h.result.current.attach()
    })
    // id 가 정해질 때까지 지금 표시는 그대로
    expect(h.result.current.link).toMatchObject({ phase: 'failed', seq: 4 })
    h.emit(ev('pty-2', { phase: 'waiting', attempt: 1, seq: 1 }))
    act(() => h.result.current.setId('pty-2'))
    expect(h.result.current.link).toMatchObject({ phase: 'waiting', attempt: 1, seq: 1 })
  })

  // AC-09 — 늦게 온 옛 상태로 되돌아가지 않는다
  it('지금 seq 이하의 이벤트는 버린다', async () => {
    const h = await attached()
    act(() => h.result.current.setId('pty-1', link({ phase: 'waiting', attempt: 3, seq: 7 })))
    h.emit(ev('pty-1', { phase: 'connecting', attempt: 3, seq: 7 }))
    h.emit(ev('pty-1', { phase: 'failed', attempt: 5, seq: 6 }))
    expect(h.result.current.link).toMatchObject({ phase: 'waiting', attempt: 3, seq: 7 })
    h.emit(ev('pty-1', { phase: 'failed', attempt: 5, seq: 8 }))
    expect(h.result.current.link).toMatchObject({ phase: 'failed', attempt: 5, seq: 8 })
  })

  // EC-10 — 같은 호스트의 다른 패널 상태는 섞이지 않는다
  it('다른 터미널(id)의 이벤트는 무시한다', async () => {
    const h = await attached()
    act(() => h.result.current.setId('pty-1'))
    h.emit(ev('pty-2', { phase: 'waiting', attempt: 1, seq: 1 }))
    expect(h.result.current.link).toBeNull()
    h.emit(ev('pty-1', { phase: 'waiting', attempt: 1, seq: 1 }))
    expect(h.result.current.link).toMatchObject({ phase: 'waiting' })
  })

  // AC-03 — 다시 접속하면 안내가 사라진다
  it('connected 이벤트를 받으면 link 는 null(연결됨)', async () => {
    const h = await attached()
    act(() => h.result.current.setId('pty-1'))
    h.emit(ev('pty-1', { phase: 'waiting', attempt: 1, seq: 1 }))
    expect(h.result.current.link).not.toBeNull()
    h.emit(ev('pty-1', { phase: 'connected', attempt: 0, seq: 2, at: '14:02' }))
    expect(h.result.current.link).toBeNull()
    expect(h.result.current.linkRef.current).toBeNull()
  })

  // D-25 — ③ 은 3초 동안
  it('실시간 connecting → connected 전이에서 justConnectedAt 이 그 시각이 되고 3초 뒤 null', async () => {
    vi.useFakeTimers()
    const h = await attached()
    act(() => h.result.current.setId('pty-1'))
    h.emit(ev('pty-1', { phase: 'connecting', attempt: 1, seq: 1 }))
    expect(h.result.current.justConnectedAt).toBeNull()
    h.emit(ev('pty-1', { phase: 'connected', attempt: 0, seq: 2, at: '14:02' }))
    expect(h.result.current.justConnectedAt).toBe('14:02')
    act(() => void vi.advanceTimersByTime(2999))
    expect(h.result.current.justConnectedAt).toBe('14:02')
    act(() => void vi.advanceTimersByTime(1))
    expect(h.result.current.justConnectedAt).toBeNull()
  })

  // D-25 — 늦게 붙은 화면이 지난 성공을 다시 알리지 않는다(실시간 전이에서만)
  it('스냅샷이 connected 이면 ③ 을 띄우지 않는다 — 그 뒤의 실시간 전이에서는 띄운다', async () => {
    const h = await attached()
    act(() => h.result.current.setId('pty-1', link({ phase: 'connected', attempt: 0, seq: 5, at: '13:58' })))
    expect(h.result.current.link).toBeNull()
    expect(h.result.current.justConnectedAt).toBeNull()
    h.emit(ev('pty-1', { phase: 'connecting', attempt: 1, seq: 6 }))
    h.emit(ev('pty-1', { phase: 'connected', attempt: 0, seq: 7, at: '14:03' }))
    expect(h.result.current.justConnectedAt).toBe('14:03')
  })

  // D-25 — 새 상태가 오면 ③ 을 바로 바꾼다
  it('③ 을 보이는 3초 안에 새 이벤트(waiting)가 오면 justConnectedAt 은 바로 null', async () => {
    vi.useFakeTimers()
    const h = await attached()
    act(() => h.result.current.setId('pty-1'))
    h.emit(ev('pty-1', { phase: 'connecting', attempt: 1, seq: 1 }))
    h.emit(ev('pty-1', { phase: 'connected', attempt: 0, seq: 2, at: '14:02' }))
    expect(h.result.current.justConnectedAt).toBe('14:02')
    act(() => void vi.advanceTimersByTime(1000))
    h.emit(ev('pty-1', { phase: 'waiting', attempt: 1, seq: 3 }))
    expect(h.result.current.justConnectedAt).toBeNull()
    expect(h.result.current.link).toMatchObject({ phase: 'waiting', attempt: 1 })
  })

  // AC-10 — [다시 시작] 은 새 PTY 라 이전 터미널의 연결 상태를 이어받지 않는다
  it('reset() 은 상태를 모두 처음으로 되돌린다', async () => {
    const h = await attached()
    act(() => h.result.current.setId('pty-1'))
    h.emit(ev('pty-1', { phase: 'failed', attempt: 5, seq: 4 }))
    expect(h.result.current.link).toMatchObject({ phase: 'failed' })
    act(() => h.result.current.reset())
    expect(h.result.current.link).toBeNull()
    expect(h.result.current.justConnectedAt).toBeNull()
    expect(h.result.current.linkRef.current).toBeNull()
  })
})
