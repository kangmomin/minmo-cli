// 여러 화면이 함께 쓰는 상태 — 이 PC 의 창과 원격으로 붙은 기기가 같은 저장소 목록·작업 폴더 위치·패널 구성을 본다.
// 각 화면의 store 는 평소처럼 브라우저 저장소(localStorage)에 남기고, 호스트의 파일(sharedGet/sharedSet)을 기준 값으로 맞춘다:
//   · 시작할 때 호스트에 값이 있으면 그것을 적용하고, 없으면(이 기능 전의 설치) 지금 값을 올린다
//   · 이 화면에서 바뀌면 호스트에 올린다. 그 사이 다른 화면이 먼저 올렸으면(판 번호가 다르면) 호스트가 거절하고,
//     이 화면은 다시 읽어 "내가 바꾼 것"만 그 위에 얹어 다시 올린다 — 통째로 덮어써서 남의 변경을 지우지 않는다
//   · 다른 화면이 바꾸면 내려받아 같은 방식으로 합친다
import type { TauriApi } from './tauri'

/** 바뀐 뒤 이만큼 모아서 올린다(연속된 변경을 한 번으로) */
export const SHARED_PUSH_DELAY_MS = 150
/** 호스트가 "그 사이 다른 화면이 저장했다"고 거절할 때의 오류(src-tauri/src/remote.rs SHARED_CONFLICT) */
export const SHARED_CONFLICT = 'shared_conflict'
const MAX_RETRIES = 4

export interface SharedBinding<T> {
  key: string
  /** 함께 쓸 부분만 꺼낸다 */
  pick(): T
  /** 내려받은 값을 store 에 적용한다(모양이 맞지 않는 값은 무시해야 한다) */
  apply(value: T): void
  /** store 가 바뀔 때마다 부른다 */
  subscribe(onChange: () => void): () => void
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const isPrimitiveList = (v: unknown): v is (string | number)[] => Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')

/**
 * 세 갈래 합치기: base(마지막으로 맞춘 값)에서 mine(이 화면)이 바꾼 것만 theirs(호스트의 지금 값) 위에 얹는다.
 * 객체는 depth 단계까지 키별로 합친다(예: 패널 구성은 이슈별로, 저장소 목록은 저장소별로) — 서로 다른 항목을 바꾼 두 화면의
 * 변경이 모두 남는다. 같은 항목을 둘 다 바꿨으면 이 화면의 값이 이긴다. 글자·숫자 목록은 집합처럼 합친다.
 * 돌려주는 undefined 는 "지워짐"이다.
 */
export function merge3(base: unknown, mine: unknown, theirs: unknown, depth = 2): unknown {
  if (depth > 0 && isObject(mine) && isObject(theirs)) {
    const b = isObject(base) ? base : {}
    const out: Record<string, unknown> = {}
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
      const v = merge3(b[k], mine[k], theirs[k], depth - 1)
      if (v !== undefined) out[k] = v
    }
    return out
  }
  if (isPrimitiveList(mine) && isPrimitiveList(theirs)) {
    const b = isPrimitiveList(base) ? base : []
    const added = mine.filter((x) => !b.includes(x))
    const removed = b.filter((x) => !mine.includes(x))
    return [...theirs.filter((x) => !removed.includes(x)), ...added.filter((x) => !theirs.includes(x))]
  }
  return same(mine, base) ? theirs : mine
}

function newOrigin(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 묶은 것을 푸는 함수를 돌려준다 */
export function bindShared<T>(tauri: Pick<TauriApi, 'sharedGet' | 'sharedSet' | 'onSharedChanged'>, b: SharedBinding<T>): () => void {
  const origin = newOrigin()
  let stopped = false
  /** 마지막으로 호스트와 맞춘 값과 그 판 번호 */
  let synced: T | undefined
  let rev = 0
  let ready = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanups: (() => void)[] = []
  // 올리기·내려받기는 한 번에 하나씩 — 겹치면 판 번호와 맞춘 값이 어긋난다
  let queue: Promise<void> = Promise.resolve()
  const enqueue = (job: () => Promise<void>) => {
    queue = queue.then(job).catch(() => undefined)
    return queue
  }

  /** 호스트의 지금 값을 읽어 이 화면의 변경과 합친다. 합친 결과가 호스트와 다르면 true(올려야 한다) */
  const reconcile = async (): Promise<boolean> => {
    const got = await tauri.sharedGet(b.key)
    if (stopped) return false
    rev = got.rev
    if (got.value === null) return true
    let theirs: T
    try {
      theirs = JSON.parse(got.value) as T
    } catch {
      // 깨진 값은 무시한다 — 이 화면의 값으로 덮는다
      return true
    }
    const mine = b.pick()
    // 처음(맞춘 적이 없을 때)에는 호스트의 값이 기준이다 — 이 화면의 저장소에 남은 옛 값으로 덮지 않는다
    const merged = synced === undefined ? theirs : (merge3(synced, mine, theirs) as T)
    synced = theirs
    if (!same(merged, mine)) b.apply(merged)
    return !same(b.pick(), theirs)
  }

  const push = async () => {
    for (let i = 0; i < MAX_RETRIES && !stopped; i++) {
      const mine = b.pick()
      if (synced !== undefined && same(mine, synced)) return
      try {
        rev = await tauri.sharedSet(b.key, JSON.stringify(mine), origin, rev)
        synced = mine
        return
      } catch (e) {
        if (!String(e instanceof Error ? e.message : e).includes(SHARED_CONFLICT)) return
        // 그 사이 다른 화면이 저장했다 — 다시 읽어 합친 뒤 올린다
        if (!(await reconcile())) return
      }
    }
  }

  void enqueue(async () => {
    const unlisten = await tauri.onSharedChanged((e) => {
      if (e.key !== b.key || e.origin === origin) return
      void enqueue(async () => {
        if (await reconcile()) await push()
      })
    })
    if (stopped) return unlisten()
    cleanups.push(unlisten)
    const needsPush = await reconcile()
    if (stopped) return
    ready = true
    // 호스트에 아직 없으면(또는 적용한 결과가 다르면) 이 화면의 값을 올린다
    if (needsPush) await push()
  })

  cleanups.push(
    b.subscribe(() => {
      if (!ready) return
      clearTimeout(timer)
      timer = setTimeout(() => void enqueue(push), SHARED_PUSH_DELAY_MS)
    }),
  )

  return () => {
    stopped = true
    clearTimeout(timer)
    for (const c of cleanups) c()
  }
}
