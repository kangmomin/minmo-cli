// 준비 로그 store — 항목 seq(CR-12): 단조 증가·유일, 2000줄 상한 slice 와 clearLog 뒤에도 재사용되지 않는다
import { beforeEach, describe, expect, it } from 'vitest'

import { MAX_LOG_LINES, useSetupStore } from './setup'

beforeEach(() => {
  useSetupStore.setState({ targets: {}, open: {}, script: {}, logs: {} })
})

const log = (issueId: string, message: string) => useSetupStore.getState().appendLog({ issueId, step: 'clone', status: 'log', message })
const seqs = (id: string) => (useSetupStore.getState().logs[id] ?? []).map((e) => e.seq)

describe('appendLog seq', () => {
  it('이슈와 무관하게 단조 증가하는 seq 를 붙인다', () => {
    log('a', '1')
    log('b', '2')
    log('a', '3')
    const [a1, a2] = seqs('a')
    const [b1] = seqs('b')
    expect(a1).toBeLessThan(b1)
    expect(b1).toBeLessThan(a2)
  })

  it(`${MAX_LOG_LINES}줄 상한으로 앞부분이 잘려도 남은 항목의 seq 는 그대로이고 유일하다`, () => {
    for (let i = 0; i < MAX_LOG_LINES; i++) log('a', `m${i}`)
    const before = seqs('a')
    log('a', 'new')
    const after = seqs('a')
    expect(after).toHaveLength(MAX_LOG_LINES)
    expect(after.slice(0, -1)).toEqual(before.slice(1))
    expect(new Set(after).size).toBe(MAX_LOG_LINES)
    expect([...after].sort((x, y) => x - y)).toEqual(after)
    expect(useSetupStore.getState().logs.a.at(-1)?.message).toBe('new')
  })

  it('clearLog 뒤 새 항목은 이전에 쓴 seq 를 다시 쓰지 않는다', () => {
    log('a', '1')
    log('a', '2')
    const used = seqs('a')
    useSetupStore.getState().clearLog('a')
    log('a', '3')
    expect(used).not.toContain(seqs('a')[0])
    expect(seqs('a')[0]).toBeGreaterThan(Math.max(...used))
  })
})
