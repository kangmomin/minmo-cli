import { createContext, useContext } from 'react'

/**
 * "GitHub 에 올리기" 대화상자를 여는 함수(로컬 저장소 id). 대화상자는 사이드바에 둔다 —
 * 올리기가 끝나면 그 저장소 노드가 로컬 목록에서 사라지므로, 노드 안에 두면 완료 안내도 함께 사라진다.
 */
export const PublishContext = createContext<(id: string) => void>(() => {})

export const useOpenPublish = () => useContext(PublishContext)
