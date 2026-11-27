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

// TODO(#115 Red 스텁): U1 에서 채운다
export const useSettingsPageStore = create<SettingsPageState>()(() => ({
  open: false,
  section: 'appearance',
  target: null,
  scope: { kind: 'global' },
  focusSection: false,
  opener: null,
  openSettings: () => {},
  close: () => {},
  setSection: () => {},
  setScope: () => {},
}))

export const openSettings = (o?: OpenSettingsOptions) => useSettingsPageStore.getState().openSettings(o)
