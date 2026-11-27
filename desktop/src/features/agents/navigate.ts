// 에이전트가 있는 터미널 패널로 가기 — 전체 현황의 줄과 OS 알림을 눌렀을 때 쓴다.
import { useEffect } from 'react'

import type { IssueTarget } from '@minmo/core'

import { useBaseDeps } from '../../app/deps'
import { hostOf, probeHost } from '../../app/host'
import type { Host } from '../../app/host'
import type { NotifyTarget, TauriApi } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import type { IssueActions } from '../issue/useWorktree'
import { leafIds } from '../terminal/panes'

/**
 * 그 이슈의 터미널 탭을 열고 패널을 고른다. keyboard 면 그 터미널이 키 입력도 받게 한다
 * (사용자가 그 패널을 직접 가리킨 경우만 — 자동 포커스 금지 AX-02). 그 패널로 갔으면 true(#122)
 */
export function goToPane(issueId: string, paneId: string, keyboard = false): boolean {
  const ui = useUiStore.getState()
  ui.selectIssue(issueId)
  ui.setTab('terminal')
  // 그 사이 닫힌 패널이면 이슈의 터미널 탭까지만 간다
  if (!leafIds(ui.panes[issueId]?.tree ?? null).includes(paneId)) return false
  ui.focusPane(issueId, paneId)
  if (keyboard) useUiStore.setState((s) => ({ focusRequest: { paneId, token: (s.focusRequest?.token ?? 0) + 1 } }))
  return true
}

export type OpenPaneResult = 'ok' | 'failed' | 'stale'

export interface OpenPaneOptions {
  actionsFor: (host: Host) => IssueActions
  tauri: Pick<TauriApi, 'sshProbe'>
  /** 그 이슈의 원격 호스트 별칭(이 PC 면 null) */
  alias: string | null
  target: IssueTarget
  /** 갈 패널(null 이면 그 이슈의 터미널 탭까지) */
  paneId: string | null
  keyboard: boolean
  /** 시간 제한(그 시각, Date.now() 기준 ms) */
  deadline: number
  /** 사용자가 화면을 바꾸는 등으로 이 이동이 쓸모없어졌는가 */
  isStale(): boolean
}

/**
 * 이 창에서 열지 않은 이슈의 패널로 간다(#122): 원격이면 연결 → 열기(기다리지 않음) → 준비될 때까지 → 그 패널.
 */
export async function openPaneTarget(o: OpenPaneOptions): Promise<OpenPaneResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, o.deadline - Date.now()))
  })
  const halted = (): OpenPaneResult | null => (o.isStale() ? 'stale' : Date.now() >= o.deadline ? 'failed' : null)
  try {
    const { alias } = o
    // Why: 연결하지 못한 원격 이슈를 이 PC 에서 열지 않게 — deepLink 와 같은 순서
    if (alias !== null && !useHostsStore.getState().probes[alias]) await Promise.race([probeHost(o.tauri, alias), timeout])
    const before = halted()
    if (before) return before
    const probe = alias === null ? undefined : useHostsStore.getState().probes[alias]
    if (alias !== null && !probe) return 'failed'
    const host = hostOf(alias, probe?.tmux ?? false)
    const issueId = host.issueId(o.target.owner, o.target.repo, o.target.key)
    // Why: open 은 준비 스크립트가 끝날 때까지 돌 수 있다 — 기다리지 않고 phase 가 ready 가 되는 때를 본다
    void o.actionsFor(host).open(o.target).catch(() => undefined)
    // Why: open 이 옛 error 를 opening 으로 바꾼 뒤에 읽어야 실패로 잘못 보지 않는다
    const phase = await new Promise<'ready' | 'error' | null>((resolve) => {
      const check = () => {
        const p = useSetupStore.getState().open[issueId]?.phase
        if (p === 'ready' || p === 'error') resolve(p)
      }
      unsubscribe = useSetupStore.subscribe(check)
      check()
      void timeout.then(() => resolve(null))
    })
    const after = halted()
    if (after) return after
    if (phase !== 'ready') return 'failed'
    if (o.paneId === null) {
      useUiStore.getState().setTab('terminal')
      return 'ok'
    }
    return goToPane(issueId, o.paneId, o.keyboard) ? 'ok' : 'failed'
  } catch {
    return 'failed'
  } finally {
    clearTimeout(timer)
    unsubscribe?.()
  }
}

/** 알림을 눌렀을 때: 이 PC 의 것이면 창을 앞으로 가져와 그 패널로, 다른 PC 의 것이면 그 PC 의 화면을 연다 */
export function openNotifyTarget(tauri: TauriApi, target: NotifyTarget) {
  if (target.kind === 'peer') {
    void tauri.peerOpen(target.peerId, target.target ? { target: target.target, paneId: target.paneId } : undefined).catch(() => undefined)
    return
  }
  void tauri.appShow().catch(() => undefined)
  goToPane(target.issueId, target.paneId, true)
}

/** 알림 클릭을 듣는다. 앱에 한 번만 마운트한다 */
export function useNotifyClick() {
  const { tauri } = useBaseDeps()
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    void tauri
      .onNotifyClick((target) => {
        if (!disposed) openNotifyTarget(tauri, target)
      })
      .then((un) => {
        if (disposed) un()
        else unlisten = un
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [tauri])
}
