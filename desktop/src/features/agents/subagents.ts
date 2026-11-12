// Claude Code 의 하위 에이전트 — 세션 기록 폴더의 agent-<id>.meta.json 을 해석한다.
// 공개된 규격이 아니라 버전에 따라 달라질 수 있다: 해석하지 못한 파일은 건너뛴다.
import type { SubagentFile } from '../../lib/tauri'

export type Subagent = {
  id: string
  /** 에이전트 종류(예: general-purpose, Explore) */
  type: string
  /** 맡긴 일의 짧은 설명 */
  description: string
  finished: boolean
  /** 마지막으로 활동한 시각(ms) */
  updatedAt: number
}

/** Claude Code 가 작업 폴더 경로로 폴더 이름을 만드는 방식(영문·숫자가 아닌 글자 → `-`) — Rust 의 project_slug 와 같다 */
export const claudeProjectSlug = (cwd: string) => cwd.replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9]/g, '-')

const text = (v: unknown) => (typeof v === 'string' ? v : '')

/** 실행 중인 것 먼저, 그 안에서는 최근에 활동한 것부터 */
export function parseSubagentFiles(files: readonly SubagentFile[]): Subagent[] {
  const out: Subagent[] = []
  for (const f of files) {
    let meta: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(f.meta)
      if (typeof parsed !== 'object' || parsed === null) continue
      meta = parsed as Record<string, unknown>
    } catch {
      continue
    }
    out.push({ id: f.id, type: text(meta.agentType) || 'agent', description: text(meta.description), finished: meta.finished === true, updatedAt: f.updatedMs })
  }
  return out.sort((a, b) => Number(a.finished) - Number(b.finished) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}

export const runningCount = (subs: readonly Subagent[] | undefined) => (subs ?? []).filter((s) => !s.finished).length

/**
 * 원격 호스트에서 같은 것을 읽는 스크립트. $1 = 작업 폴더의 slug.
 * 한 줄에 하나씩 "<id>\t<meta 가 바뀐 시각(초)>\t<기록이 바뀐 시각(초)>\t<meta.json 한 줄>"
 */
export const REMOTE_SUBAGENTS_SCRIPT = `d="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
[ -d "$d" ] || exit 0
p=""
for c in "$d"/*; do
  [ -d "$c" ] || continue
  n=$(basename "$c" | sed 's/[^A-Za-z0-9]/-/g')
  if [ "$n" = "$1" ]; then p="$c"; break; fi
done
[ -n "$p" ] || exit 0
s=$(ls -t "$p"/*.jsonl 2>/dev/null | head -n 1)
[ -n "$s" ] || exit 0
dir="\${s%.jsonl}/subagents"
[ -d "$dir" ] || exit 0
mt() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
ls -t "$dir"/agent-*.meta.json 2>/dev/null | head -n 100 | while IFS= read -r m; do
  [ -z "$(find "$m" -prune -size +128)" ] || continue
  id=$(basename "$m" .meta.json)
  printf '%s\\t%s\\t%s\\t' "$id" "$(mt "$m")" "$(mt "\${m%.meta.json}.jsonl")"
  tr -d '\\n\\r' < "$m"
  printf '\\n'
done`

/** 위 스크립트의 출력 → SubagentFile 목록 */
export function parseRemoteSubagents(stdout: string): SubagentFile[] {
  const out: SubagentFile[] = []
  for (const line of stdout.split('\n')) {
    const [id, metaAt, logAt, ...rest] = line.split('\t')
    if (!id || !id.startsWith('agent-') || rest.length === 0) continue
    const sec = Math.max(Number(metaAt) || 0, Number(logAt) || 0)
    out.push({ id, meta: rest.join('\t'), updatedMs: sec * 1000 })
  }
  return out
}
