// 호스트(이 PC 의 창) 쪽 일: 붙은 기기가 보낸 호출을 대신 실행하고, 함께 쓰는 상태를 호스트의 파일과 맞춘다.
import { useEffect } from 'react'

import type { TauriApi } from '../../lib/tauri'
import { bindSharedStores } from '../../store/shared'
import { useUiStore } from '../../store/ui'

/** 호스트가 허용 목록으로 이미 걸렀지만(remote.rs ALLOWED), 화면에서도 이 PC 전용 호출은 실행하지 않는다 */
const NEVER = /^(on[A-Z]|remote|keychain|server|app|openDir$|openUrl$|pickFolder$|notify$|sshHostSave$|sshHostRemove$|runtime$)/

export async function runRemoteCall(tauri: TauriApi, method: string, args: unknown[]): Promise<unknown> {
  const fn = (tauri as unknown as Record<string, unknown>)[method]
  if (NEVER.test(method) || typeof fn !== 'function') throw new Error(`원격에서 쓸 수 없는 기능입니다: ${method}`)
  // JSON 으로 오면서 생략한 인자(undefined)는 null 이 된다 — 선택 인자는 undefined 로 되돌린다
  return (fn as (...a: unknown[]) => unknown).apply(tauri, args.map((a) => (a === null ? undefined : a)))
}

/** 실패 사유를 한 줄로(ssh 오류처럼 객체로 던지는 것도 있다) */
function reason(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') return e.message
  return String(e)
}

/** Tauri 창에서만: 붙은 기기의 호출을 실행해 답한다 */
export function useRemoteBridge(tauri: TauriApi) {
  useEffect(() => {
    if (tauri.runtime !== 'native') return
    let stop: (() => void) | null = null
    let disposed = false
    void tauri
      .onRemoteRpc((req) => {
        runRemoteCall(tauri, req.method, Array.isArray(req.args) ? req.args : [])
          .then((value) => tauri.remoteRpcReply(req.id, true, value ?? null))
          .catch((e: unknown) => tauri.remoteRpcReply(req.id, false, reason(e)))
          .catch(() => undefined)
      })
      .then((un) => {
        if (disposed) un()
        else stop = un
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      stop?.()
    }
  }, [tauri])
}

/** 저장소 목록·작업 폴더 위치·패널 구성을 호스트의 파일과 맞춘다(이 PC 의 창과 붙은 기기 모두) */
export function useSharedStores(tauri: TauriApi) {
  useEffect(() => bindSharedStores(tauri), [tauri])
}

const TERMINAL_POLL_MS = 4000

/**
 * 이 화면이 열어 보지 않은 패널의 터미널도 에이전트 현황에 보이게, 호스트에 떠 있는 터미널 목록을 주기적으로 받아
 * 패널 → 터미널 표(terminalIds)에 채운다. mock(개발·테스트)에서는 하지 않는다.
 */
export function useSharedTerminals(tauri: TauriApi) {
  useEffect(() => {
    if (tauri.runtime === 'mock') return
    /** 이 훅이 채운 항목 — 터미널이 사라지면 이것만 지운다(화면이 직접 연 터미널은 그 화면이 관리한다) */
    const mine = new Map<string, string>()
    let disposed = false
    const sync = async () => {
      const list = await tauri.ptyList().catch(() => null)
      if (disposed || !list) return
      const alive = new Map(list.flatMap((p) => (p.key ? [[p.key, p.id] as const] : [])))
      useUiStore.setState((s) => {
        let next = s.terminalIds
        const set = (k: string, v: string | undefined) => {
          if (next === s.terminalIds) next = { ...s.terminalIds }
          if (v === undefined) delete next[k]
          else next[k] = v
        }
        for (const [key, id] of alive) {
          if (!(key in s.terminalIds)) {
            set(key, id)
            mine.set(key, id)
          }
        }
        for (const [key, id] of mine) {
          if (alive.get(key) !== id) {
            if (s.terminalIds[key] === id) set(key, undefined)
            mine.delete(key)
          }
        }
        return next === s.terminalIds ? s : { terminalIds: next }
      })
    }
    void sync()
    const timer = setInterval(() => void sync(), TERMINAL_POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [tauri])
}
