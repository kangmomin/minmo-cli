// CLI 별 모델 목록 원문(agentModelsRaw) → 선택지. 순수 함수
// 형식이 CLI 버전마다 바뀔 수 있어, 읽지 못하면 던지고 화면은 오류 문구 + 직접 입력으로 대신한다(EC-06)

export type ModelOption = { id: string; name: string }

/** Claude 의 모델 목록 캐시가 없을 때 쓰는 별칭 */
export const CLAUDE_ALIASES: ModelOption[] = [
  { id: 'opus', name: 'Opus' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'haiku', name: 'Haiku' },
]

function unreadable(raw: string): Error {
  const head = raw.trim().split(/\r?\n/, 1)[0].slice(0, 200)
  return new Error(head ? `모델 목록을 읽지 못했습니다: ${head}` : '모델 목록을 읽지 못했습니다')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

/** JSON 앞뒤에 경고 줄이 섞여 나와도 첫 `{`·`[` 부터 마지막 `}`·`]` 까지를 읽어 본다 */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    const start = raw.search(/[[{]/)
    const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'))
    if (start < 0 || end <= start) return undefined
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

/** `{"catalog": <*-cc.json>, "masked": <masked-ids.json>}` — 캐시가 없으면 별칭(A-5) */
export function parseClaudeCatalog(raw: string): ModelOption[] {
  if (raw.trim() === '') return [...CLAUDE_ALIASES]
  const data = parseJson(raw)
  if (!isRecord(data)) throw unreadable(raw)
  if (data.catalog == null) return [...CLAUDE_ALIASES]
  const cat = data.catalog
  const models = isRecord(cat) && isRecord(cat.catalog) && isRecord(cat.catalog.config) ? cat.catalog.config.models : undefined
  if (!Array.isArray(models)) throw unreadable(raw)
  const masked = new Set(isRecord(data.masked) && Array.isArray(data.masked.ids) ? data.masked.ids.filter((x) => typeof x === 'string') : [])
  const list = models.flatMap((m): ModelOption[] => {
    if (!isRecord(m)) return []
    const id = str(m.id)
    return id && !masked.has(id) ? [{ id, name: str(m.name) ?? id }] : []
  })
  return list.length > 0 ? list : [...CLAUDE_ALIASES]
}

/** `codex debug models` 출력(JSON) — 목록에 보이는(visibility list) 모델만 priority 순으로 */
export function parseCodexModels(raw: string): ModelOption[] {
  const data = parseJson(raw)
  const models = isRecord(data) ? data.models : undefined
  if (!Array.isArray(models)) throw unreadable(raw)
  const list = models
    .flatMap((m) => {
      if (!isRecord(m) || m.visibility !== 'list') return []
      const id = str(m.slug) ?? str(m.id)
      if (!id) return []
      return [{ id, name: str(m.display_name) ?? id, priority: typeof m.priority === 'number' ? m.priority : Infinity }]
    })
    .sort((a, b) => a.priority - b.priority)
    .map(({ id, name }) => ({ id, name }))
  if (list.length === 0) throw unreadable(raw)
  return list
}

/** `gemini models list -o json`(JSON) 또는 `gemini --list-models`(텍스트) 출력 */
export function parseGeminiModels(raw: string): ModelOption[] {
  const data = parseJson(raw)
  const items = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.models) ? data.models : undefined
  const list = items
    ? items.flatMap((m): ModelOption[] => {
        if (!isRecord(m)) return []
        const id = str(m.id) ?? str(m.modelId)
        return id ? [{ id, name: str(m.displayName) ?? id }] : []
      })
    : // 텍스트: 들여쓰지 않은 "id (이름)" 줄이 모델, 들여쓴 줄은 그 모델의 설명
      raw.split(/\r?\n/).flatMap((line): ModelOption[] => {
        const m = /^([^\s()]+) \((.+)\)\s*$/.exec(line)
        return m ? [{ id: m[1], name: m[2] }] : []
      })
  if (list.length === 0) throw unreadable(raw)
  return list
}
