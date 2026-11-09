import type { SettingsInput, SettingsRecord, SettingsScope, SettingsValues } from '@minmo/api-client'

export type SettingsFormData = {
  /** 이 scope 에 저장된 레코드 */
  record: SettingsRecord | undefined
  /** 상위 scope 조합 값 (E6 + E8 (+E10)) — placeholder "상속: …" 출처. global 은 null */
  inherited: SettingsValues | null
  isLoading: boolean
}

// STUB (Phase 6.1 Red)
export function useSettings(_scope: SettingsScope): SettingsFormData & {
  save(input: SettingsInput): Promise<SettingsRecord>
  isSaving: boolean
} {
  throw new Error('not implemented')
}
