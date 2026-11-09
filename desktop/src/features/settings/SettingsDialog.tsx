import type { SettingsScope } from '@minmo/api-client'

export type PreviewIssue = { owner: string; repo: string; key: string; number: number | null; title: string }

export interface SettingsDialogProps {
  scope: SettingsScope
  open: boolean
  onOpenChange(open: boolean): void
  /** 하단 미리보기 기준 이슈(브랜치명·해석된 worktree 경로) */
  previewIssue?: PreviewIssue | null
}

// STUB (Phase 6.1 Red) — 접근성 계약(라벨·testid)은 SettingsDialog.test.tsx 참조
export function SettingsDialog(_props: SettingsDialogProps) {
  return null
}
