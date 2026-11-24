// 역할 설정의 모델 선택지 — 사이드바에서 고른 호스트(useHost, A-15)에서 그 CLI 의 모델 목록을 가져온다
import { useQuery } from '@tanstack/react-query'

import { useDeps } from '../../app/deps'
import { useHost } from '../../app/host'
import { parseClaudeCatalog, parseCodexModels, parseGeminiModels } from './models'
import type { ModelOption } from './models'
import type { RoleKind } from './roles'

const PARSE: Record<RoleKind, (raw: string) => ModelOption[]> = {
  claude: parseClaudeCatalog,
  codex: parseCodexModels,
  gemini: parseGeminiModels,
}

export const agentModelsKey = (hostAlias: string | null, kind: RoleKind) => ['agent-models', hostAlias, kind] as const

/** 목록은 CLI 를 업데이트하기 전에는 잘 바뀌지 않는다 — 한 번 받으면 [새로 고침] 전까지 그대로 쓴다 */
export function useAgentModels(kind: RoleKind) {
  const host = useHost()
  const { tauri } = useDeps()
  return useQuery({
    queryKey: agentModelsKey(host.alias, kind),
    queryFn: async () => PARSE[kind](await tauri.agentModelsRaw(kind)),
    staleTime: Infinity,
  })
}
