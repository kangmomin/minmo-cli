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

// STUB (Phase 6.1 Red)
export const useNoteDraftStore = create<NoteDraftState>()(() => ({
  drafts: {},
  save: () => {},
  take: () => null,
  discardOtherUsers: () => {},
}))
