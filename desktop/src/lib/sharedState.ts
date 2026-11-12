// 여러 화면이 함께 쓰는 상태 — 이 PC 의 창과 원격으로 붙은 기기가 같은 저장소 목록·작업 폴더 위치·패널 구성을 본다.
// 각 화면의 store 는 평소처럼 브라우저 저장소(localStorage)에 남기고, 호스트의 파일(sharedGet/sharedSet)을 기준 값으로 맞춘다:
//   · 시작할 때 호스트에 값이 있으면 그것을 적용하고, 없으면(이 기능 전의 설치) 지금 값을 올린다
//   · 이 화면에서 바뀌면 호스트에 올리고, 다른 화면이 바꾸면 내려받아 적용한다
import type { TauriApi } from './tauri'

/** 바뀐 뒤 이만큼 모아서 올린다(연속된 변경을 한 번으로) */
export const SHARED_PUSH_DELAY_MS = 150

export interface SharedBinding<T> {
  key: string
  /** 함께 쓸 부분만 꺼낸다 */
  pick(): T
  /** 내려받은 값을 store 에 적용한다(모양이 맞지 않는 값은 무시해야 한다) */
  apply(value: T): void
  /** store 가 바뀔 때마다 부른다 */
  subscribe(onChange: () => void): () => void
}

function newOrigin(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 묶은 것을 푸는 함수를 돌려준다 */
export function bindShared<T>(tauri: Pick<TauriApi, 'sharedGet' | 'sharedSet' | 'onSharedChanged'>, b: SharedBinding<T>): () => void {
  const origin = newOrigin()
  let stopped = false
  /** 마지막으로 호스트와 맞춘 값 — 같은 값을 다시 올리거나, 내려받은 값을 되올리지 않게 */
  let synced: string | null = null
  let ready = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanups: (() => void)[] = []

  const pull = async () => {
    const raw = await tauri.sharedGet(b.key)
    if (stopped || raw === null || raw === synced) return raw
    try {
      const value = JSON.parse(raw) as T
      synced = raw
      b.apply(value)
      // 적용한 결과가 내려받은 값과 다를 수 있다(모양 보정) — 그 차이를 되올리지 않도록 지금 값을 기준으로 삼는다
      synced = JSON.stringify(b.pick())
    } catch {
      // 깨진 값은 무시한다 — 다음 변경 때 이 화면의 값으로 덮인다
    }
    return raw
  }

  const push = () => {
    if (stopped || !ready) return
    const json = JSON.stringify(b.pick())
    if (json === synced) return
    synced = json
    tauri.sharedSet(b.key, json, origin).catch(() => {
      // 올리지 못했으면 다음 변경 때 다시 올린다
      synced = null
    })
  }

  void (async () => {
    try {
      const unlisten = await tauri.onSharedChanged((e) => {
        if (e.key === b.key && e.origin !== origin) void pull().catch(() => undefined)
      })
      if (stopped) return unlisten()
      cleanups.push(unlisten)
      const existing = await pull()
      if (stopped) return
      ready = true
      // 호스트에 아직 없으면 이 화면의 값을 올린다(처음 한 번)
      if (existing === null) push()
    } catch {
      // 공유 상태를 쓸 수 없는 환경 — 이 화면의 저장소만으로 동작한다
    }
  })()

  cleanups.push(
    b.subscribe(() => {
      if (!ready) return
      clearTimeout(timer)
      timer = setTimeout(push, SHARED_PUSH_DELAY_MS)
    }),
  )

  return () => {
    stopped = true
    clearTimeout(timer)
    for (const c of cleanups) c()
  }
}
