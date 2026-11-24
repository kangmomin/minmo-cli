// 에이전트 실행 대기열 — 꺼냄(take)·입력 직전 확인(consume)·취소(cancel)·입력 대기 여부(isLaunchPending) (#92)
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LAUNCH_TTL_MS, cancelLaunch, consumeLaunch, isLaunchPending, queueLaunch, takeLaunch } from './launchQueue'

const P = 'acme/app#1::2'

afterEach(() => {
  vi.useRealTimers()
  // 다음 테스트에 남지 않게
  takeLaunch(P)
})

describe('launchQueue (#92)', () => {
  // EC-12 — 입력 대기(take 전) 판정
  it('EC-12 맡긴 명령은 꺼내기 전까지 입력 대기, 꺼내면 대기가 아니다', () => {
    queueLaunch(P, 'claude')
    expect(isLaunchPending(P)).toBe(true)
    expect(takeLaunch(P)).toBe('claude')
    expect(isLaunchPending(P)).toBe(false)
  })

  // EC-12 — TTL
  it('EC-12 TTL(120초)이 지나면 입력 대기가 아니다', () => {
    vi.useFakeTimers()
    queueLaunch(P, 'claude')
    vi.advanceTimersByTime(LAUNCH_TTL_MS - 1)
    expect(isLaunchPending(P)).toBe(true)
    vi.advanceTimersByTime(2)
    expect(isLaunchPending(P)).toBe(false)
    expect(takeLaunch(P)).toBeUndefined()
  })

  // EC-22 — 꺼낸 명령은 입력 직전 한 번만 확인된다
  it('EC-22 꺼낸 명령은 입력 직전 consume 이 한 번만 true', () => {
    queueLaunch(P, 'claude')
    takeLaunch(P)
    expect(consumeLaunch(P)).toBe(true)
    expect(consumeLaunch(P)).toBe(false)
  })

  // EC-22 — 꺼낸 뒤 취소
  it('EC-22 꺼내 들고 있는 동안 취소하면 consume 이 false — 입력하지 않는다', () => {
    queueLaunch(P, 'claude')
    expect(takeLaunch(P)).toBe('claude')
    cancelLaunch(P)
    expect(consumeLaunch(P)).toBe(false)
  })

  // EC-22 — 같은 paneId 에 새 명령
  it('EC-22 꺼낸 뒤 같은 패널에 새 명령을 맡기면 옛 명령의 consume 은 false, 새 명령은 꺼내고 입력된다', () => {
    queueLaunch(P, 'old')
    expect(takeLaunch(P)).toBe('old')
    queueLaunch(P, 'new')
    expect(consumeLaunch(P)).toBe(false)
    expect(takeLaunch(P)).toBe('new')
    expect(consumeLaunch(P)).toBe(true)
  })

  // EC-16 — 패널이 뜨기 전 취소
  it('EC-16 꺼내기 전에 취소하면 나중에 터미널이 떠도 명령이 나오지 않는다', () => {
    queueLaunch(P, 'claude')
    cancelLaunch(P)
    expect(isLaunchPending(P)).toBe(false)
    expect(takeLaunch(P)).toBeUndefined()
  })
})
