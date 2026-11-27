import { useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'

import { useBaseDeps } from '../../app/deps'
import { hostOf } from '../../app/host'
import { isPrimaryWindow } from '../../lib/windowScope'
import { useHostsStore } from '../../store/hosts'
import { useIssueActionsFor } from '../issue/useWorktree'
import { createTakerEngine } from './engine'
import type { TakerEngine, TakerEngineDeps } from './engine'
import { TAKER_CHECK_MS } from './taker'
import { useTakerStore } from './takerStore'

export type TakerActions = Pick<TakerEngine, 'stop' | 'restart' | 'nextStep'>

const TakerActionsContext = createContext<TakerActions | null>(null)

const TICK_MS = 1000

export function useIssueTaker(): TakerActions | null {
  const base = useBaseDeps()
  const queryClient = useQueryClient()
  const actionsFor = useIssueActionsFor()
  const runs = base.tauri.runtime !== 'remote' && isPrimaryWindow()
  const latest = useRef({ base, queryClient, actionsFor })
  latest.current = { base, queryClient, actionsFor }
  const engineRef = useRef<TakerEngine | null>(null)

  useEffect(() => {
    if (!runs) return
    // Why: 다시 렌더링할 때마다 엔진을 새로 만들면 start 가 진행 중인 실행을 중단됨으로 바꾼다 — 바뀌는 값은 ref 로 읽는다
    const deps: TakerEngineDeps = {
      get github() {
        return latest.current.base.github
      },
      get tauri() {
        return latest.current.base.tauri
      },
      actionsFor: (alias) => {
        const probe = alias === null ? undefined : useHostsStore.getState().probes[alias]
        return latest.current.actionsFor(alias !== null && probe ? hostOf(alias, probe.tmux) : hostOf(alias))
      },
      queryClient: { invalidateQueries: (...args) => latest.current.queryClient.invalidateQueries(...args) },
      getPlatform: () => latest.current.base.platform,
      now: () => Date.now(),
    }
    const engine = createTakerEngine(deps)
    engineRef.current = engine
    engine.start(Date.now())
    void engine.check(Date.now())
    const tick = setInterval(() => void engine.tick(Date.now()), TICK_MS)
    const check = setInterval(() => void engine.check(Date.now()), TAKER_CHECK_MS)
    const unsubscribe = useTakerStore.subscribe((s, prev) => {
      if (Object.entries(s.repos).some(([k, c]) => c.enabled && prev.repos[k]?.enabled !== true)) void engine.check(Date.now())
    })
    return () => {
      clearInterval(tick)
      clearInterval(check)
      unsubscribe()
      engine.dispose()
      if (engineRef.current === engine) engineRef.current = null
    }
  }, [runs])

  return useMemo(
    () =>
      runs
        ? {
            stop: (id: string) => engineRef.current?.stop(id),
            restart: (id: string) => engineRef.current?.restart(id),
            nextStep: (id: string) => engineRef.current?.nextStep(id) ?? 'notReady',
          }
        : null,
    [runs],
  )
}

export function TakerActionsProvider({ value, children }: { value: TakerActions | null; children: ReactNode }) {
  return <TakerActionsContext.Provider value={value}>{children}</TakerActionsContext.Provider>
}

export function useTakerActions(): TakerActions | null {
  return useContext(TakerActionsContext)
}
