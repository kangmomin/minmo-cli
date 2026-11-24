// E2E 큐 store — 추가·중복 방지·순서·단계 넘김·취소·다시 실행·지우기·확인 필요 표시
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { queueLaunch, takeLaunch } from '../agents/launchQueue'
import { useE2eQueueStore } from './queueStore'
import type { E2eJob } from './queueStore'

const A = 'acme/app#1'
const B = 'acme/app#2'
const C = 'acme/app#3'

const q = () => useE2eQueueStore.getState()
const job = (issueId: string): E2eJob => q().jobs.find((j) => j.issueId === issueId && (j.status === 'queued' || j.status === 'running'))!

beforeEach(() => {
  useE2eQueueStore.setState({ jobs: [] })
})

afterEach(() => {
  takeLaunch(`${A}::2`)
})

describe('enqueue', () => {
  // EC-04
  it('EC-04 같은 이슈가 대기·실행 중이면 추가하지 않는다(false) — 끝난 뒤에는 다시 추가할 수 있다', () => {
    expect(q().enqueue(A, '#1 로그인')).toBe(true)
    expect(q().enqueue(A, '#1 로그인')).toBe(false)
    expect(q().jobs).toHaveLength(1)
    q().start(job(A).id)
    expect(q().enqueue(A, '#1 로그인')).toBe(false)
    expect(q().jobs).toHaveLength(1)
    q().fail(job(A).id, 'x')
    expect(q().enqueue(A, '#1 로그인')).toBe(true)
  })

  // AC-02
  it('AC-02 추가한 순서대로 대기열에 선다(전역 FIFO)', () => {
    q().enqueue(A, 'a')
    q().enqueue(B, 'b')
    q().enqueue(C, 'c')
    expect(q().jobs.map((j) => [j.issueId, j.status])).toEqual([
      [A, 'queued'],
      [B, 'queued'],
      [C, 'queued'],
    ])
    expect(new Set(q().jobs.map((j) => j.id)).size).toBe(3)
  })
})

describe('advance', () => {
  // AC-06
  it('AC-06 현재 단계를 완료 처리하면 다음 단계로, ③이면 작업 완료', () => {
    q().enqueue(A, 'a')
    const id = job(A).id
    q().start(id)
    expect(job(A)).toMatchObject({ status: 'running', stage: 0 })
    q().advance(id, 0)
    expect(job(A)).toMatchObject({ status: 'running', stage: 1 })
    q().advance(id, 1)
    q().advance(id, 2)
    expect(q().jobs.find((j) => j.id === id)?.status).toBe('done')
  })

  // EC-13
  it('EC-13 [다음 단계]와 자동 완료가 겹쳐도 한 번만 넘어간다 — 현재 단계가 다르면 무시', () => {
    q().enqueue(A, 'a')
    const id = job(A).id
    q().start(id)
    q().advance(id, 0)
    q().advance(id, 0)
    expect(job(A).stage).toBe(1)
  })
})

describe('cancel', () => {
  // AC-07
  it('AC-07 실행 중·대기 작업을 취소한다', () => {
    q().enqueue(A, 'a')
    q().enqueue(B, 'b')
    const a = job(A).id
    const b = job(B).id
    q().start(a)
    q().cancel(a)
    q().cancel(b)
    expect(q().jobs.map((j) => j.status)).toEqual(['cancelled', 'cancelled'])
  })

  // EC-16
  it('EC-16 패널이 뜨기 전에 취소하면 그 단계의 대기 명령을 지운다 — 나중에 터미널이 떠도 실행되지 않는다', () => {
    q().enqueue(A, 'a')
    const id = job(A).id
    q().start(id)
    q().setStagePane(id, 0, `${A}::2`)
    queueLaunch(`${A}::2`, "claude 'run'")
    q().cancel(id)
    expect(takeLaunch(`${A}::2`)).toBeUndefined()
  })
})

describe('retry · remove', () => {
  // AC-08
  it('AC-08 [다시 실행]은 끝난 작업을 새 대기 작업으로 다시 추가하고, [목록에서 지우기]는 끝난 작업을 없앤다', () => {
    q().enqueue(A, '#1 로그인')
    const id = job(A).id
    q().start(id)
    q().fail(id, '터미널 패널이 닫혔습니다')
    q().retry(id)
    const again = job(A)
    expect(again).toMatchObject({ issueId: A, title: '#1 로그인', status: 'queued', stage: 0 })
    q().remove(id)
    expect(q().jobs.some((j) => j.id === id)).toBe(false)
    expect(q().jobs.some((j) => j.id === again.id)).toBe(true)
  })

  // EC-24
  it('EC-24 [다시 실행]은 항상 새 jobId(새 결과 폴더)', () => {
    q().enqueue(A, 'a')
    const id = job(A).id
    q().start(id)
    q().advance(id, 0)
    q().advance(id, 1)
    q().advance(id, 2)
    q().retry(id)
    expect(job(A).id).not.toBe(id)
  })
})

describe('setNotice', () => {
  // EC-23
  it('EC-23 확인 필요 표시를 설정·해제하고, 같은 값이면 상태를 바꾸지 않는다(다시 그리지 않게)', () => {
    q().enqueue(A, 'a')
    const id = job(A).id
    q().start(id)
    q().setNotice(id, 0, 'attention')
    expect(job(A).notice).toBe('attention')
    const before = q().jobs
    q().setNotice(id, 0, 'attention')
    expect(q().jobs).toBe(before)
    q().setNotice(id, 0, undefined)
    expect(job(A).notice).toBeUndefined()
  })
})
