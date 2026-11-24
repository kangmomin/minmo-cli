// CLI 별 모델 목록 원문(agentModelsRaw) → 선택지. 순수 함수
// TODO(Phase 5.2): 구현. 지금은 테스트가 import 할 수 있게 시그니처만 둔 스텁이다

export type ModelOption = { id: string; name: string }

/** Claude 의 모델 목록 캐시가 없을 때 쓰는 별칭 */
export const CLAUDE_ALIASES: ModelOption[] = []

/** `{"catalog": <*-cc.json>, "masked": <masked-ids.json>}` */
export function parseClaudeCatalog(_raw: string): ModelOption[] {
  throw new Error('not implemented')
}

/** `codex debug models` 출력(JSON) */
export function parseCodexModels(_raw: string): ModelOption[] {
  throw new Error('not implemented')
}

/** `gemini models list -o json`(JSON) 또는 `gemini --list-models`(텍스트) 출력 */
export function parseGeminiModels(_raw: string): ModelOption[] {
  throw new Error('not implemented')
}
