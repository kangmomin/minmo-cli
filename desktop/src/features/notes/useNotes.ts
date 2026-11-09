import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '@minmo/api-client'

import { useDeps } from '../../app/deps'
import { handleApiError, isUnauthorized } from '../../lib/apiErrors'
import { queryKeys } from '../../lib/queryKeys'
import { useNoteDraftStore } from '../../store/noteDrafts'
import { useSessionStore } from '../../store/session'

export type NotesSaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; updatedAt: string | null }
  | { kind: 'failed'; code: string }

export type NotesConflict = { body: string; updatedAt: string | null }

export const NOTES_DEBOUNCE_MS = 1000
export const NOTES_MAX_BYTES = 1_048_576

const encoder = new TextEncoder()
const utf8Length = (s: string) => encoder.encode(s).length

type Internal = {
  /** 에디터의 최신 본문 */
  body: string
  /** 다음 PUT 의 baseUpdatedAt = 직전 서버 응답의 updatedAt (없으면 null) */
  base: string | null
  /** 서버에 반영되지 않은 편집이 있다 */
  dirty: boolean
  inFlight: boolean
  /** in-flight 중 들어온 최신 본문(최신본 1개만 보관) */
  queued: string | null
  timer: ReturnType<typeof setTimeout> | null
  conflict: boolean
  userId: string | null
}

/**
 * 메모 편집 상태 (F-06). 계약 "notes 쓰기 규칙(FE)":
 * 1초 디바운스 · 이슈당 단일 in-flight(최신본만 대기열) · baseUpdatedAt = 직전 응답 updatedAt ·
 * mutation retry 0 · 409 current.body == 전송 body 면 모달 없이 saved · 401 시 미전송 본문을 사용자 키로 보존
 */
export function useNotes(
  owner: string,
  repo: string,
  key: string,
): {
  body: string
  setBody(body: string): void
  saveState: NotesSaveState
  conflict: NotesConflict | null
  loadServer(): void
  overwrite(): void
  disabled: boolean
  isLoading: boolean
} {
  const { api } = useDeps()
  const queryClient = useQueryClient()
  const token = useSessionStore((s) => s.token)
  const me = useSessionStore((s) => s.me)
  const status = useSessionStore((s) => s.status)

  const query = useQuery({
    queryKey: queryKeys.notes(owner, repo, key),
    queryFn: () => api.getNotes(owner, repo, key),
    enabled: !!token,
    gcTime: Infinity,
  })

  const [body, setBodyState] = useState('')
  const [initialized, setInitialized] = useState(false)
  const [saveState, setSaveState] = useState<NotesSaveState>({ kind: 'idle' })
  const [conflict, setConflict] = useState<NotesConflict | null>(null)
  const [r] = useState<Internal>(() => ({
    body: '',
    base: null,
    dirty: false,
    inFlight: false,
    queued: null,
    timer: null,
    conflict: false,
    userId: null,
  }))

  // 비동기 콜백이 항상 최신 의존성을 보도록 ref 로 보관
  const ctx = useRef({ api, queryClient, owner, repo, key })
  useEffect(() => {
    ctx.current = { api, queryClient, owner, repo, key }
  })

  useEffect(() => {
    if (me) r.userId = me.id
  }, [me, r])

  const saveDraft = useCallback(() => {
    const { owner: o, repo: rp, key: k } = ctx.current
    if (r.userId && r.dirty)
      useNoteDraftStore.getState().save({ userId: r.userId, owner: o, repo: rp, key: k }, { body: r.body, baseUpdatedAt: r.base })
  }, [r])

  const clearTimer = useCallback(() => {
    if (r.timer !== null) clearTimeout(r.timer)
    r.timer = null
  }, [r])

  const send = useCallback(
    function send(sent: string) {
      if (utf8Length(sent) > NOTES_MAX_BYTES) {
        setSaveState({ kind: 'failed', code: 'body_too_large' })
        return
      }
      const { api: a, queryClient: qc, owner: o, repo: rp, key: k } = ctx.current
      // 서버에 sent 가 저장됨 → 다음 PUT 의 base 갱신, 그 사이 편집이 없으면 clean
      const markSaved = (updatedAt: string | null) => {
        r.base = updatedAt
        if (r.body === sent) r.dirty = false
        setSaveState({ kind: 'saved', updatedAt })
      }
      r.inFlight = true
      setSaveState({ kind: 'saving' })
      a.putNotes(o, rp, k, { body: sent, baseUpdatedAt: r.base })
        .then((res) => {
          markSaved(res.updatedAt)
          qc.setQueryData(queryKeys.notes(o, rp, k), res)
        })
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.code === 'conflict' && e.current) {
            const current = e.current
            if (current.body === sent) {
              // 자기 409(같은 본문이 이미 저장됨) 흡수
              markSaved(current.updatedAt)
            } else {
              r.conflict = true
              r.queued = null
              setConflict(current)
              setSaveState({ kind: 'failed', code: 'conflict' })
            }
            return
          }
          if (isUnauthorized(e)) {
            saveDraft()
            handleApiError(e, { queryClient: qc })
            setSaveState({ kind: 'failed', code: 'unauthorized' })
            return
          }
          handleApiError(e)
          setSaveState({ kind: 'failed', code: e instanceof ApiError ? e.code : 'unknown' })
        })
        .finally(() => {
          r.inFlight = false
          if (r.queued !== null && !r.conflict) {
            const next = r.queued
            r.queued = null
            send(next)
          }
        })
    },
    [r, saveDraft],
  )

  const requestSave = useCallback(() => {
    if (r.conflict || !r.dirty) return
    const st = useSessionStore.getState()
    if (!st.token || st.status === 'offline') return
    if (r.inFlight) {
      r.queued = r.body
      return
    }
    send(r.body)
  }, [r, send])

  const schedule = useCallback(() => {
    clearTimer()
    r.timer = setTimeout(() => {
      r.timer = null
      requestSave()
    }, NOTES_DEBOUNCE_MS)
  }, [r, clearTimer, requestSave])

  // 서버 본문으로 초기화(+ 같은 사용자의 보존 본문 복원). 편집 중이 아니면 재조회 결과도 반영
  const data = query.data
  useEffect(() => {
    if (!data) return
    if (!initialized) {
      r.base = data.updatedAt
      let initial = data.body
      const uid = useSessionStore.getState().me?.id
      if (uid) {
        const draft = useNoteDraftStore.getState().take({ userId: uid, owner, repo, key })
        if (draft !== null && draft.body !== data.body) {
          // 방금 GET 한 updatedAt 이 아니라 초안 작성 당시의 base 로 저장해야
          // 그 사이 다른 기기의 수정을 덮어쓰지 않고 409 모달로 드러낸다(RF-01, CT-15)
          initial = draft.body
          r.base = draft.baseUpdatedAt
          r.dirty = true
          schedule()
        }
      }
      r.body = initial
      setBodyState(initial)
      setInitialized(true)
      return
    }
    if (!r.dirty && !r.inFlight && !r.conflict && data.updatedAt !== r.base) {
      r.base = data.updatedAt
      r.body = data.body
      setBodyState(data.body)
    }
  }, [data, initialized, owner, repo, key, r, schedule])

  // 세션이 끊기면(전송 전 디바운스 포함) 미전송 본문을 보존
  useEffect(() => {
    if (token) return
    if (r.dirty) {
      clearTimer()
      saveDraft()
    }
  }, [token, r, clearTimer, saveDraft])

  // 오프라인에서 복귀하면 미저장 본문을 다시 저장
  useEffect(() => {
    if (status === 'online' && initialized && r.dirty && !r.inFlight && !r.conflict && r.timer === null) schedule()
  }, [status, initialized, r, schedule])

  // 언마운트(이슈 전환): 대기 중인 본문은 즉시 전송, 불가하면 보존
  useEffect(
    () => () => {
      clearTimer()
      if (!r.dirty) return
      const st = useSessionStore.getState()
      if (r.inFlight) {
        if (!r.conflict) r.queued = r.body
      } else if (st.token && st.status === 'online' && !r.conflict) {
        send(r.body)
      } else {
        saveDraft()
      }
    },
    [r, clearTimer, send, saveDraft],
  )

  const setBody = useCallback(
    (b: string) => {
      r.body = b
      r.dirty = true
      setBodyState(b)
      schedule()
    },
    [r, schedule],
  )

  const loadServer = useCallback(() => {
    if (!conflict) return
    clearTimer()
    r.body = conflict.body
    r.base = conflict.updatedAt
    r.dirty = false
    r.queued = null
    r.conflict = false
    setBodyState(conflict.body)
    setConflict(null)
    const { queryClient: qc, owner: o, repo: rp, key: k } = ctx.current
    qc.setQueryData(queryKeys.notes(o, rp, k), { body: conflict.body, updatedAt: conflict.updatedAt })
    setSaveState({ kind: 'saved', updatedAt: conflict.updatedAt })
  }, [conflict, clearTimer, r])

  const overwrite = useCallback(() => {
    if (!conflict) return
    clearTimer()
    r.base = conflict.updatedAt
    r.conflict = false
    setConflict(null)
    send(r.body)
  }, [conflict, clearTimer, r, send])

  return {
    body,
    setBody,
    saveState,
    conflict,
    loadServer,
    overwrite,
    disabled: status === 'offline' || !token || !initialized,
    // 서버 본문으로 초기화되기 전에는 에디터를 보여 주지 않는다(입력이 초기화로 덮이지 않도록)
    isLoading: !initialized,
  }
}
