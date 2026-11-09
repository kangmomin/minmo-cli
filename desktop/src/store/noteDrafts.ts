import { create } from 'zustand'

/** UI State Contract "세션 없음/401": 디바운스 대기·전송 실패 본문을 이 키로 메모리에 보존 */
export type DraftKey = { userId: string; owner: string; repo: string; key: string }

export interface NoteDraftState {
  drafts: Record<string, string>
  save(k: DraftKey, body: string): void
  /** 같은 사용자 키면 꺼내고(삭제) 반환, 없으면 null */
  take(k: DraftKey): string | null
  /** 다른 사용자로 로그인하면 그 외 사용자의 초안 폐기 */
  discardOtherUsers(userId: string): void
}

const SEP = '\u0000'
// owner/repo 는 서버 저장 키와 같이 대소문자를 무시한다
const keyOf = (k: DraftKey) => [k.userId, k.owner.toLowerCase(), k.repo.toLowerCase(), k.key].join(SEP)

// 메모리 전용(영속 저장 안 함 — Plan 기각 항목 "오프라인 draft 영속화")
export const useNoteDraftStore = create<NoteDraftState>()((set, get) => ({
  drafts: {},
  save: (k, body) => set((s) => ({ drafts: { ...s.drafts, [keyOf(k)]: body } })),
  take: (k) => {
    const id = keyOf(k)
    const body = get().drafts[id]
    if (body === undefined) return null
    set((s) => {
      const next = { ...s.drafts }
      delete next[id]
      return { drafts: next }
    })
    return body
  },
  discardOtherUsers: (userId) =>
    set((s) => ({
      drafts: Object.fromEntries(Object.entries(s.drafts).filter(([id]) => id.split(SEP)[0] === userId)),
    })),
}))
