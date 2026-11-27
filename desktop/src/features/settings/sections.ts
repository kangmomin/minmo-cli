// 설정 화면(#115)의 분류 목록과 검색 — 순수 함수만 둔다
import type { RuntimeKind } from '../../lib/tauri'

export type SectionId = 'appearance' | 'notify' | 'agents' | 'workspace' | 'sync' | 'hosts' | 'remote' | 'cli' | 'server'

export interface Section {
  id: SectionId
  title: string
  keywords: string[]
  visible(runtime: RuntimeKind): boolean
}

// TODO(#115 Red 스텁): U1 에서 채운다
export const SECTIONS: Section[] = []

export function visibleSections(_runtime: RuntimeKind): Section[] {
  return []
}

export function filterSections(list: Section[], _query: string): Section[] {
  return list
}
