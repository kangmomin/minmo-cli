import { create } from 'zustand'

/** UI State Contract "세션 없음/401": 디바운스 대기·전송 실패 본문을 이 키로 메모리에 보존 */
export type DraftKey = { userId: string; owner: string; repo: string; key: string }

/**
 * 보존 본문 + 작성 당시 알던 서버 updatedAt.
 * 복원 PUT 은 이 base 를 그대로 써야 그 사이 다른 기기의 수정을 409 로 감지한다(notes 쓰기 규칙).
 */
export type NoteDraft = { body: string; baseUpdatedAt: string | null }

export interface NoteDraftState {
  drafts: Record<string, NoteDraft>
  save(k: DraftKey, draft: NoteDraft): void
  /** 같은 사용자 키면 꺼내고(삭제) 반환, 없으면 null */
  take(k: DraftKey): NoteDraft | null
  /** 다른 사용자로 로그인하면 그 외 사용자의 초안 폐기 */
  discardOtherUsers(userId: string): void
}

const SEP = '\u0000'
// owner/repo 는 서버 저장 키와 같이 대소문자를 무시한다
const keyOf = (k: DraftKey) => [k.userId, k.owner.toLowerCase(), k.repo.toLowerCase(), k.key].join(SEP)

// 메모리 전용(영속 저장 안 함 — Plan 기각 항목 "오프라인 draft 영속화")
export const useNoteDraftStore = create<NoteDraftState>()((set, get) => ({
  drafts: {},
  save: (k, draft) => set((s) => ({ drafts: { ...s.drafts, [keyOf(k)]: draft } })),
  take: (k) => {
    const id = keyOf(k)
    const draft = get().drafts[id]
    if (draft === undefined) return null
    set((s) => {
      const next = { ...s.drafts }
      delete next[id]
      return { drafts: next }
    })
    return draft
  },
  discardOtherUsers: (userId) =>
    set((s) => ({
      drafts: Object.fromEntries(Object.entries(s.drafts).filter(([id]) => id.split(SEP)[0] === userId)),
    })),
}))
