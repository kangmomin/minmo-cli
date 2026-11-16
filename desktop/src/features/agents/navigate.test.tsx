// 알림 클릭 → 그 터미널 패널로 가기
import { beforeEach, describe, expect, it } from 'vitest'

import type { NotifyTarget } from '../../lib/tauri'
import { parseNotifyTarget } from '../../lib/tauri'
import { useUiStore } from '../../store/ui'
import { createFakeTauri } from '../../test/fakes'
import { makeDeps, renderHookWithDeps } from '../../test/render'
import { leaf, splitPane } from '../terminal/panes'
import { useNotifyClick } from './navigate'

const ISSUE = 'acme/app#1'
const P1 = `${ISSUE}::1`
const P2 = `${ISSUE}::2`

/** 훅을 마운트하고, 알림을 누른 것처럼 알리는 함수를 돌려준다 */
async function setup() {
  let click!: (t: NotifyTarget) => void
  const fake = createFakeTauri({
    onNotifyClick: async (cb) => {
      click = cb
      return () => {}
    },
  })
  renderHookWithDeps(() => useNotifyClick(), makeDeps({ tauri: fake.tauri }))
  await Promise.resolve()
  return { tauri: fake.tauri, click }
}

beforeEach(() => {
  useUiStore.setState({
    selectedIssueId: 'acme/app#9',
    tab: 'notes',
    focusRequest: null,
    panes: { [ISSUE]: { tree: splitPane(leaf(P1), P1, 'row', P2), focused: P1, seq: 2 } },
  })
})

describe('알림 클릭(useNotifyClick)', () => {
  it('이 PC 의 알림: 창을 앞으로 가져오고 그 이슈의 터미널 탭에서 그 패널에 포커스를 준다', async () => {
    const t = await setup()
    t.click({ kind: 'local', issueId: ISSUE, paneId: P2 })
    expect(t.tauri.appShow).toHaveBeenCalledTimes(1)
    const ui = useUiStore.getState()
    expect(ui.selectedIssueId).toBe(ISSUE)
    expect(ui.tab).toBe('terminal')
    expect(ui.panes[ISSUE].focused).toBe(P2)
    expect(ui.focusRequest).toEqual({ paneId: P2, token: 1 })
  })

  it('그 사이 닫힌 패널이면 이슈의 터미널 탭까지만 간다', async () => {
    const t = await setup()
    t.click({ kind: 'local', issueId: ISSUE, paneId: `${ISSUE}::7` })
    const ui = useUiStore.getState()
    expect(ui.selectedIssueId).toBe(ISSUE)
    expect(ui.tab).toBe('terminal')
    expect(ui.panes[ISSUE].focused).toBe(P1)
    expect(ui.focusRequest).toBeNull()
  })

  it('다른 PC 의 알림: 그 PC 의 화면을 그 터미널로 연다 — 이 PC 의 화면은 그대로 둔다', async () => {
    const t = await setup()
    const target = { owner: 'acme', repo: 'app', key: '1', number: 1, title: '로그인' }
    t.click({ kind: 'peer', peerId: 'p1', paneId: P1, target })
    expect(t.tauri.peerOpen).toHaveBeenCalledWith('p1', { target, paneId: P1 })
    t.click({ kind: 'peer', peerId: 'p1', paneId: P1, target: null })
    expect(t.tauri.peerOpen).toHaveBeenLastCalledWith('p1', undefined)
    expect(t.tauri.appShow).not.toHaveBeenCalled()
    expect(useUiStore.getState().selectedIssueId).toBe('acme/app#9')
  })
})

describe('parseNotifyTarget', () => {
  it('모양이 맞는 것만 받는다', () => {
    expect(parseNotifyTarget({ kind: 'local', issueId: ISSUE, paneId: P1, extra: 1 })).toEqual({ kind: 'local', issueId: ISSUE, paneId: P1 })
    expect(parseNotifyTarget({ kind: 'peer', peerId: 'p1', paneId: P1, target: 'x' })).toEqual({ kind: 'peer', peerId: 'p1', paneId: P1, target: null })
    for (const bad of [null, undefined, 'x', {}, { kind: 'local', paneId: P1 }, { kind: 'local', issueId: ISSUE }, { kind: 'peer', paneId: P1 }, { kind: 'other', issueId: ISSUE, paneId: P1 }]) {
      expect(parseNotifyTarget(bad)).toBeNull()
    }
  })
})
