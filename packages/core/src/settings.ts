// 설정 기본값·검증·병합 — 서버(server/internal/settings)와 같은 규칙.
// 서버 없이 쓰는 CLI 로컬 모드가 설정을 직접 검사·계산할 때 쓴다(서버 규칙을 바꾸면 여기도 함께 바꾼다).
import { isValidRef } from '@minmo/api-client'
import type { SettingsField, SettingsValues } from '@minmo/api-client'

/** 선언 순서 = 서버 검증 순서 */
export const SETTING_FIELDS: readonly SettingsField[] = [
  'branchTemplate',
  'etcBranchName',
  'worktreePath',
  'mainClonePath',
  'postCreateScript',
  'sparsePaths',
  'postCreateScriptPosix',
]

/** 신규 사용자 전역 기본값(model.go Defaults) */
export const DEFAULT_SETTINGS: Readonly<SettingsValues> = {
  branchTemplate: 'issue/{number}-{slug}',
  etcBranchName: 'etc',
  worktreePath: '~/minmo-workspaces/{owner}/{repo}/{branch}',
  mainClonePath: '~/minmo-workspaces/{owner}/{repo}/_main',
  postCreateScript: '',
  sparsePaths: '',
  postCreateScriptPosix: '',
}

export type SettingErrorCode = 'invalid_template' | 'invalid_path_template' | 'script_too_large' | 'invalid_sparse_paths'

const MAX_BRANCH_RUNES = 100
const MAX_PATH_RUNES = 512
const MAX_SCRIPT_BYTES = 65536
const MAX_SPARSE_BYTES = 4096
const MAX_SPARSE_LINES = 100

const BRANCH_TOKENS = new Set(['number', 'slug', 'title'])
const WORKTREE_PATH_TOKENS = new Set(['owner', 'repo', 'branch', 'key', 'number', 'slug'])
const MAIN_CLONE_TOKENS = new Set(['owner', 'repo'])

const runes = (s: string) => Array.from(s).length
const bytes = (s: string) => new TextEncoder().encode(s).length
// Go unicode.IsControl 과 같은 범위(C0·DEL·C1)
const CONTROL = /\p{Cc}/u
// Go strings.TrimSpace — JS trim() 은 U+FEFF 를 지우고 U+0085 를 남겨 서버와 어긋난다
const trimSpace = (s: string) => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')

/** `{name}` 토큰 목록. 닫히지 않은 `{` 가 있으면 null(홀로 닫는 `}` 는 허용 — 서버와 같다) */
function parseTokens(s: string): string[] | null {
  const tokens: string[] = []
  let rest = s
  for (;;) {
    const open = rest.indexOf('{')
    if (open < 0) return tokens
    const end = rest.indexOf('}', open + 1)
    if (end < 0) return null
    tokens.push(rest.slice(open + 1, end))
    rest = rest.slice(end + 1)
  }
}

const allAllowed = (tokens: string[], allowed: Set<string>) => tokens.every((t) => allowed.has(t))

function checkBranchTemplate(v: string): SettingErrorCode | null {
  if (v === '' || runes(v) > MAX_BRANCH_RUNES) return 'invalid_template'
  const tokens = parseTokens(v)
  if (!tokens || !allAllowed(tokens, BRANCH_TOKENS) || !tokens.includes('number')) return 'invalid_template'
  // 샘플 치환 후 git ref 규칙
  const sample = v.replaceAll('{number}', '1').replaceAll('{slug}', 'x').replaceAll('{title}', 'x')
  return isValidRef(sample) ? null : 'invalid_template'
}

function checkEtcBranchName(v: string): SettingErrorCode | null {
  if (v === '' || runes(v) > MAX_BRANCH_RUNES || /[{}]/.test(v) || !isValidRef(v)) return 'invalid_template'
  return null
}

function checkWorktreePath(v: string): SettingErrorCode | null {
  if (v === '' || runes(v) > MAX_PATH_RUNES) return 'invalid_path_template'
  const tokens = parseTokens(v)
  if (!tokens || !allAllowed(tokens, WORKTREE_PATH_TOKENS) || !(tokens.includes('branch') || tokens.includes('key'))) return 'invalid_path_template'
  return null
}

function checkMainClonePath(v: string): SettingErrorCode | null {
  if (v === '' || runes(v) > MAX_PATH_RUNES) return 'invalid_path_template'
  const tokens = parseTokens(v)
  if (!tokens || !allAllowed(tokens, MAIN_CLONE_TOKENS)) return 'invalid_path_template'
  return null
}

const checkScript = (v: string): SettingErrorCode | null => (bytes(v) > MAX_SCRIPT_BYTES ? 'script_too_large' : null)

/** 줄마다 저장소 루트 기준 상대 디렉터리(cone). glob·부정·절대·`..`·옵션처럼 보이는 `-` 시작을 막는다 */
function checkSparsePaths(v: string): SettingErrorCode | null {
  if (bytes(v) > MAX_SPARSE_BYTES) return 'invalid_sparse_paths'
  const lines = v.split('\n')
  if (lines.length > MAX_SPARSE_LINES) return 'invalid_sparse_paths'
  for (const line of lines) {
    const p = trimSpace(line)
    if (p === '') continue
    if (/^[/!#-]/.test(p) || /[\\:*?[\]]/.test(p)) return 'invalid_sparse_paths'
    for (const seg of p.replace(/\/$/, '').split('/')) {
      if (seg === '' || seg === '.' || seg === '..') return 'invalid_sparse_paths'
    }
    if (CONTROL.test(p)) return 'invalid_sparse_paths'
  }
  return null
}

const CHECKS: Record<SettingsField, (v: string) => SettingErrorCode | null> = {
  branchTemplate: checkBranchTemplate,
  etcBranchName: checkEtcBranchName,
  worktreePath: checkWorktreePath,
  mainClonePath: checkMainClonePath,
  postCreateScript: checkScript,
  sparsePaths: checkSparsePaths,
  postCreateScriptPosix: checkScript,
}

/** 값 하나를 서버와 같은 규칙으로 검사한다. 위반이면 서버 오류 코드, 통과면 null */
export function validateSettingValue(field: SettingsField, value: string): SettingErrorCode | null {
  return CHECKS[field](value)
}

export type SettingsLayer<S extends string> = { source: S; values?: Partial<Record<SettingsField, string | null>> | null }
export type MergedSettings<S extends string> = { values: SettingsValues; sources: Record<SettingsField, S> }

/** base 위에 layers 를 순서대로 덮는다 — null·undefined 는 아래 값을 그대로 두고, ""도 값으로 본다(서버 Merge 와 같다) */
export function mergeSettings<S extends string>(base: SettingsValues, baseSource: S, layers: SettingsLayer<S>[]): MergedSettings<S> {
  const values = { ...base }
  const sources = Object.fromEntries(SETTING_FIELDS.map((f) => [f, baseSource])) as Record<SettingsField, S>
  for (const layer of layers) {
    for (const f of SETTING_FIELDS) {
      const v = layer.values?.[f]
      if (v === null || v === undefined) continue
      values[f] = v
      sources[f] = layer.source
    }
  }
  return { values, sources }
}
