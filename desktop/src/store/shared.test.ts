// 함께 쓰는 상태 — 지운 기능(E2E 큐, #92)의 공유 키 `e2e` 는 더 이상 읽거나 쓰지 않는다(#111 CT-03)
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFakeTauri } from '../test/fakes'
import { bindSharedStores } from './shared'

let stop: (() => void) | null = null

afterEach(() => {
  stop?.()
  stop = null
})

describe('공유 키 (#111)', () => {
  it('CT-03 호스트에 e2e 값이 남아 있어도 e2e 키를 읽거나 쓰지 않는다', async () => {
    const sharedGet = vi.fn(async (key: string) => (key === 'e2e' ? { value: '{"run":{}}', rev: 3 } : { value: null, rev: 0 }))
    const sharedSet = vi.fn(async (_key: string, _value: string, _origin: string, base: number) => base + 1)
    const { tauri } = createFakeTauri({ sharedGet, sharedSet })
    stop = bindSharedStores(tauri)
    // 남은 키(repos·hosts·ui)를 다 읽을 때까지 기다린 뒤 확인한다
    await waitFor(() => expect(sharedGet.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['repos', 'hosts', 'ui'])))
    expect(sharedGet.mock.calls.map((c) => c[0])).not.toContain('e2e')
    expect(sharedSet.mock.calls.map((c) => c[0])).not.toContain('e2e')
  })
})
