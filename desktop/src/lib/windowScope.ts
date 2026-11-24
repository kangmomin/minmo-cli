// 창 정체성과 범위(이슈 #105) — 같은 앱 화면을 여러 창으로 띄운다.
// main 창(주 창)은 닫히지 않고(트레이·종료) 항상 있으므로, 한 번만 돌아야 하는 일(원격 호출 처리·동기화·OS 알림)은 주 창만 맡는다.
// 보조 창은 index.html?window=ws&scope=… 로 뜬다(src-tauri/src/shell.rs window_open). 범위를 URL 에 두어 새로 고쳐도 유지된다.
import type { StateStorage } from 'zustand/middleware'

import type { TauriApi } from './tauri'

export type WindowScope =
  | { kind: 'org'; owner: string }
  | { kind: 'repo'; owner: string; repo: string }
  | { kind: 'group'; id: string }

function params(search: string = typeof location === 'undefined' ? '' : location.search): URLSearchParams {
  return new URLSearchParams(search)
}

/** 이 화면이 주 창인가(보조 창 표시가 없으면 주 창 — 원격 화면·브라우저 포함) */
export function isPrimaryWindow(search?: string): boolean {
  return params(search).get('window') !== 'ws'
}

/**
 * 이 PC 에서 한 번만 돌아야 하는 일(붙은 기기의 호출 처리·동기화·현황 올리기)을 이 화면이 맡는가.
 * 네이티브 주 창만 맡는다 — 이벤트는 모든 창에 가므로 창마다 돌리면 같은 일이 창 수만큼 일어난다
 */
export function ownsAppTasks(tauri: Pick<TauriApi, 'runtime'>): boolean {
  return tauri.runtime === 'native' && isPrimaryWindow()
}

/** 이 창이 보일 범위(없으면 전체) */
export function windowScope(search?: string): WindowScope | null {
  const raw = params(search).get('scope')
  return raw === null ? null : decodeScope(raw)
}

export function scopeToString(scope: WindowScope): string {
  switch (scope.kind) {
    case 'org':
      return `org:${scope.owner}`
    case 'repo':
      return `repo:${scope.owner}/${scope.repo}`
    case 'group':
      return `group:${scope.id}`
  }
}

export function decodeScope(raw: string): WindowScope | null {
  const i = raw.indexOf(':')
  if (i < 0) return null
  const kind = raw.slice(0, i)
  const rest = raw.slice(i + 1)
  if (rest === '') return null
  if (kind === 'org') return { kind, owner: rest }
  if (kind === 'group') return { kind, id: rest }
  if (kind === 'repo') {
    const j = rest.indexOf('/')
    if (j <= 0 || j === rest.length - 1) return null
    return { kind, owner: rest.slice(0, j), repo: rest.slice(j + 1) }
  }
  return null
}

/**
 * URL 쿼리 값으로 인코딩한다. 네이티브 쪽은 퍼센트 인코딩된 문자([A-Za-z0-9%-_.~])만 받으므로
 * encodeURIComponent 가 남기는 !'()* 도 인코딩한다
 */
export function encodeScope(scope: WindowScope): string {
  return encodeURIComponent(scopeToString(scope)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * persist 저장소 래퍼 — 모든 창이 같은 localStorage 를 쓴다(#105).
 * persist 는 바뀔 때마다 상태 전체를 쓰므로, 그대로 두면 한 창이 읽어 둔 옛 값으로 다른 창이 바꾼 설정(테마 등)을 덮는다.
 * 그래서 이 창이 마지막으로 읽거나 쓴 값과 비교해 **이 창이 바꾼 키만** 저장된 값 위에 쓴다.
 * - own: 창마다 다른 값(지금 보는 이슈 등). 보조 창은 쓰지 않고, 시작한 뒤에는 다른 창의 값으로 바꾸지 않는다
 * - fresh: 보조 창이 처음 읽을 때 비운다(기본값으로 시작). own 의 일부여야 한다
 */
export function perWindowStorage(own: string[], fresh: string[] = [], primary: boolean = isPrimaryWindow()): StateStorage {
  const base = new Map<string, Record<string, unknown>>()
  const read = new Set<string>()
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  return {
    getItem: (name) => {
      const raw = localStorage.getItem(name)
      const parsed = parse(raw)
      if (!parsed) return raw
      base.set(name, { ...parsed.state })
      if (!primary) for (const k of read.has(name) ? own : fresh) delete parsed.state[k]
      read.add(name)
      return JSON.stringify(parsed)
    },
    setItem: (name, value) => {
      const next = parse(value)
      if (!next) return primary ? localStorage.setItem(name, value) : undefined
      const current = localStorage.getItem(name)
      const stored = parse(current)
      const prev = base.get(name)
      const state: Record<string, unknown> = { ...stored?.state }
      for (const [k, v] of Object.entries(next.state)) {
        if (!primary && own.includes(k)) continue
        if (!prev || !(k in state) || !same(v, prev[k])) state[k] = v
      }
      base.set(name, { ...next.state })
      const out = JSON.stringify({ ...next, state })
      // 같은 값이면 쓰지 않는다 — 다른 창의 storage 이벤트(→ 다시 읽기 → 다시 쓰기)가 끝없이 오가지 않게
      if (out !== current) localStorage.setItem(name, out)
    },
    // 보조 창은 저장소를 지우지 않는다(주 창의 값까지 사라진다)
    removeItem: (name) => (primary ? localStorage.removeItem(name) : undefined),
  }
}

/** 다른 창이 그 저장소를 바꾸면 다시 읽는다 — 한 창에서 바꾼 설정(알림 끄기 등)이 다른 창에도 바로 맞춰진다 */
export function followOtherWindows(name: string, rehydrate: () => unknown) {
  if (typeof window === 'undefined') return
  window.addEventListener('storage', (e) => {
    if (e.key === name) void rehydrate()
  })
}

function parse(raw: string | null): { state: Record<string, unknown>; [k: string]: unknown } | null {
  if (raw === null) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v === 'object' && v !== null && typeof (v as { state?: unknown }).state === 'object' && (v as { state: unknown }).state !== null) {
      return v as { state: Record<string, unknown> }
    }
  } catch {
    // 손으로 고친 값 등 — 그대로 둔다
  }
  return null
}
