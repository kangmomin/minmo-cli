import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'

import type { SettingsInput, SettingsRecord, SettingsScope, SettingsValues } from '@minmo/api-client'

import { useDeps } from '../../app/deps'
import { queryKeys } from '../../lib/queryKeys'

export type SettingsFormData = {
  /** 이 scope 에 저장된 레코드 */
  record: SettingsRecord | undefined
  /** 상위 scope 조합 값 (E6 + E8 (+E10)) — placeholder "상속: …" 출처. global 은 null */
  inherited: SettingsValues | null
  isLoading: boolean
}

export const SETTINGS_FIELDS = ['branchTemplate', 'etcBranchName', 'worktreePath', 'mainClonePath', 'postCreateScript'] as const

/** base 위에 레코드의 non-null 값을 덮는다 (null = 상속) */
export function overlay(base: SettingsValues, rec: SettingsRecord | undefined): SettingsValues {
  if (!rec) return base
  const out = { ...base }
  for (const f of SETTINGS_FIELDS) {
    const v = rec[f]
    if (v !== null && v !== undefined) out[f] = v
  }
  return out
}

const EMPTY_VALUES: SettingsValues = { branchTemplate: '', etcBranchName: '', worktreePath: '', mainClonePath: '', postCreateScript: '' }

export function useSettings(scope: SettingsScope): SettingsFormData & {
  save(input: SettingsInput): Promise<SettingsRecord>
  isSaving: boolean
} {
  const { api } = useDeps()
  const queryClient = useQueryClient()
  const orgOwner = scope.kind === 'global' ? null : scope.owner

  const global = useQuery({ queryKey: queryKeys.settings({ kind: 'global' }), queryFn: () => api.getSettings({ kind: 'global' }) })
  const org = useQuery({
    queryKey: queryKeys.settings({ kind: 'org', owner: orgOwner ?? '' }),
    queryFn: () => api.getSettings({ kind: 'org', owner: orgOwner ?? '' }),
    enabled: orgOwner !== null,
  })
  const project = useQuery({
    queryKey: queryKeys.settings(scope.kind === 'project' ? scope : { kind: 'project', owner: '', repo: '' }),
    queryFn: () => api.getSettings(scope),
    enabled: scope.kind === 'project',
  })

  const record = scope.kind === 'global' ? global.data : scope.kind === 'org' ? org.data : project.data

  const inherited = useMemo<SettingsValues | null>(() => {
    if (scope.kind === 'global' || !global.data) return null
    const base = overlay(EMPTY_VALUES, global.data)
    return scope.kind === 'org' ? base : overlay(base, org.data)
  }, [scope.kind, global.data, org.data])

  const isLoading =
    global.isLoading || (scope.kind !== 'global' && org.isLoading) || (scope.kind === 'project' && project.isLoading)

  const mutation = useMutation({
    mutationFn: (input: SettingsInput) => api.putSettings(scope, input),
    retry: 0,
    onSuccess: (rec) => {
      queryClient.setQueryData(queryKeys.settings(scope), rec)
      // effective(이슈 열기·경로 변경 배지)가 바뀌므로 갱신. 다른 scope 레코드는 열 때 다시 조회된다(staleTime 0)
      void queryClient.invalidateQueries({ queryKey: queryKeys.effectiveAll })
    },
  })

  return {
    record,
    inherited,
    isLoading,
    save: (input) => mutation.mutateAsync(input),
    isSaving: mutation.isPending,
  }
}
