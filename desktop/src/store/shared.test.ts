// 함께 쓰는 상태 — E2E 큐 역할 설정(별도 키 `e2e`, #92)
import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_ROLES } from '../features/e2eQueue/roles'
import type { E2eRoles } from '../features/e2eQueue/roles'
import { createFakeTauri } from '../test/fakes'
import { bindSharedStores } from './shared'
import { useUiStore } from './ui'

const ROLES: E2eRoles = {
  run: { kind: 'codex', model: 'gpt-5', prompt: '실행 {out}' },
  edge: { kind: 'gemini', model: '', prompt: '찾기 {prev} {out}' },
  verify: { kind: 'claude', model: 'opus', prompt: '검증 {prev} {out}' },
}

let stop: (() => void) | null = null

/** 호스트에 저장된 값(키별 JSON)으로 묶는다 */
function bind(stored: Record<string, unknown>) {
  const sharedSet = vi.fn(async (_key: string, _value: string, _origin: string, base: number) => base + 1)
  const { tauri } = createFakeTauri({
    sharedGet: async (key) => (key in stored ? { value: JSON.stringify(stored[key]), rev: 1 } : { value: null, rev: 0 }),
    sharedSet,
  })
  stop = bindSharedStores(tauri)
  return { sharedSet }
}

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState({ e2eRoles: DEFAULT_ROLES })
})

afterEach(() => {
  stop?.()
  stop = null
})

describe('공유 키 e2e (#92)', () => {
  // AC-10 — 공유 동기화로 저장
  it('AC-10 호스트에 아직 값이 없으면 이 화면의 역할 설정을 e2e 키로 올린다(ui 키에는 넣지 않는다)', async () => {
    useUiStore.setState({ e2eRoles: ROLES })
    const { sharedSet } = bind({})
    await waitFor(() => expect(sharedSet.mock.calls.some((c) => c[0] === 'e2e')).toBe(true))
    const sent = sharedSet.mock.calls.find((c) => c[0] === 'e2e')!
    expect(JSON.parse(sent[1])).toEqual(ROLES)
    for (const c of sharedSet.mock.calls.filter((x) => x[0] === 'ui')) expect(JSON.parse(c[1])).not.toHaveProperty('e2eRoles')
  })

  // EC-11
  it('EC-11 받은 역할 설정이 잘못된 형태면 역할별로 유효 값만 받고 나머지는 기본값', async () => {
    bind({
      e2e: { run: { kind: 'codex', model: 'gpt-5', prompt: 'p' }, edge: { kind: 'gemini', model: '; rm -rf ~', prompt: 'q' }, verify: 7 },
    })
    await waitFor(() => expect(useUiStore.getState().e2eRoles.run).toEqual({ kind: 'codex', model: 'gpt-5', prompt: 'p' }))
    expect(useUiStore.getState().e2eRoles.edge).toEqual({ kind: 'gemini', model: DEFAULT_ROLES.edge.model, prompt: 'q' })
    expect(useUiStore.getState().e2eRoles.verify).toEqual(DEFAULT_ROLES.verify)
  })
})
