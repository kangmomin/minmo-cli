import { create } from 'zustand'

import type { SettingsScope } from '@minmo/api-client'

import type { SectionId } from '../features/settings/sections'
import type { PreviewIssue } from '../features/settings/ScopeSettings'

/** 작업 공간 분류의 범위 문맥 — 트리 ⚙ 로 연 조직·저장소, 또는 상단 ⚙ 때 고른 이슈의 저장소 */
export type SettingsTarget = { context: Exclude<SettingsScope, { kind: 'global' }>; preview: PreviewIssue | null }

export interface OpenSettingsOptions {
  section?: SectionId
  target?: SettingsTarget | null
  scope?: SettingsScope
}

export interface SettingsPageState {
  open: boolean
  section: SectionId
  target: SettingsTarget | null
  scope: SettingsScope
  focusSection: boolean
  opener: HTMLElement | null
  openSettings(o?: OpenSettingsOptions): void
  close(): void
  setSection(id: SectionId): void
  setScope(s: SettingsScope): void
}

export const useSettingsPageStore = create<SettingsPageState>()((set) => ({
  open: false,
  section: 'appearance',
  target: null,
  scope: { kind: 'global' },
  focusSection: false,
  opener: null,
  openSettings: (o) => {
    const active = document.activeElement
    set((s) => ({
      open: true,
      // Why: 분류를 정하지 않고 열면 지난번에 보던 분류로 돌아간다(앱 실행 중에만 기억)
      section: o?.section ?? s.section,
      target: o?.target ?? null,
      scope: o?.scope ?? { kind: 'global' },
      focusSection: !!o?.section,
      opener: active instanceof HTMLElement && active !== document.body ? active : null,
    }))
  },
  // Why: opener·section 은 남긴다 — 닫은 뒤 포커스를 되돌리고, 다시 열 때 그 분류를 보인다
  close: () => set({ open: false }),
  setSection: (section) => set({ section }),
  setScope: (scope) => set({ scope }),
}))

export const openSettings = (o?: OpenSettingsOptions) => useSettingsPageStore.getState().openSettings(o)
