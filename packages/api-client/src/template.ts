// 템플릿 치환 (Integration Contract v2.4 §템플릿 치환, golden: contracts/fixtures/template-vectors.json)
// 순수 함수만 둔다. home·platform 은 호출자가 주입한다.

export type Platform = 'win32' | 'darwin' | 'linux'

export type BranchIssue = { number: number; title: string }
export type RenderBranchOptions = { etcBranchName?: string }

export type PathContext = {
  owner: string
  repo: string
  branch: string
  key: string
  number: number | null
  slug: string
  home: string
  platform: Platform
}

export type TemplateErrorCode = 'branch_conflicts_etc'

export class TemplateError extends Error {
  code: TemplateErrorCode
  constructor(code: TemplateErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'TemplateError'
    this.code = code
  }
}

// 서버 ref 규칙표: 공백·제어문자·`~^:?*[\` 금지 — Go unicode.IsSpace(=White_Space)·IsControl(=Cc)과 같은 범위
// (JS \s 는 U+FEFF 를 포함하고 C1 제어문자를 빼서 서버와 어긋난다)
const REF_FORBIDDEN_CHAR = /[\p{White_Space}\p{Cc}~^:?*[\\]/u
// eslint-disable-next-line no-control-regex
const REF_FORBIDDEN_CHARS_G = /[\x00-\x1f\x7f~^:?*[\\]/g

/** git ref 규칙표(서버 검증 규칙과 동일) 통과 여부 */
export function isValidRef(ref: string): boolean {
  if (ref === '' || ref === '@') return false
  if (REF_FORBIDDEN_CHAR.test(ref)) return false
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false
  if (ref.startsWith('/') || ref.endsWith('/')) return false
  if (ref.endsWith('.') || ref.endsWith('.lock')) return false
  return true
}

const trimChars = (s: string, chars: string): string => {
  let start = 0
  let end = s.length
  while (start < end && chars.includes(s[start])) start++
  while (end > start && chars.includes(s[end - 1])) end--
  return s.slice(start, end)
}

/** 코드 포인트 단위 절단(서로게이트 쌍을 자르지 않는다) */
const truncate = (s: string, max: number): string => Array.from(s).slice(0, max).join('')

/** {slug}: 소문자 → ASCII 외 제거 → [^a-z0-9]+ → '-' → 양끝 '-' 제거 → ≤40 → 비면 'issue' */
export function slug(title: string): string {
  const ascii = title
    .toLowerCase()
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\x7f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
  const s = trimChars(truncate(trimChars(ascii, '-'), 40), '-')
  return s === '' ? 'issue' : s
}

/** {title}: 공백 → '-', ref 금지 문자 제거, 대소문자 유지, ≤60, 비면 'issue' */
export function titleToken(title: string): string {
  let t = title
    .replace(/\.{2,}/g, '-')
    .replace(/@\{/g, '-')
    .replace(REF_FORBIDDEN_CHARS_G, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
  t = trimChars(t, '-.')
  t = trimChars(truncate(t, 60), '-.')
  return t === '' ? 'issue' : t
}

/** renderBranch 결과를 ref 규칙표에 맞게 정제 (말미 `.`/`.lock`, `..`·`@{`·연속/선두/말미 `/`, 빈 세그먼트) */
function refineRef(ref: string): string {
  let r = ref.replace(REF_FORBIDDEN_CHARS_G, '').replace(/\s+/g, '-')
  for (;;) {
    const before = r
    r = r.replace(/\.{2,}/g, '-').replace(/@\{/g, '-')
    r = r
      .split('/')
      .filter((s) => s !== '')
      .join('/')
    while (r.endsWith('.lock')) r = r.slice(0, -'.lock'.length)
    r = r.replace(/\.+$/, '')
    r = trimChars(r, '/')
    if (r === before) break
  }
  return r
}

/** branchTemplate 렌더 + ref 최종 정제. 결과가 etcBranchName 과 같으면 TemplateError('branch_conflicts_etc') */
export function renderBranch(template: string, issue: BranchIssue, opts?: RenderBranchOptions): string {
  const values: Record<string, string> = {
    number: String(issue.number),
    slug: slug(issue.title),
    title: titleToken(issue.title),
  }
  // 한 번에 치환해야 제목 안의 `{...}` 가 다시 토큰으로 해석되지 않는다
  const rendered = template.replace(/\{(number|slug|title)\}/g, (_m, k: string) => values[k])
  const branch = refineRef(rendered)
  if (opts?.etcBranchName !== undefined && branch === opts.etcBranchName) {
    throw new TemplateError('branch_conflicts_etc', '브랜치명이 기타 브랜치와 충돌합니다')
  }
  return branch
}

/** 브랜치명 → 디렉터리명 ('/' → '--') */
export function branchDir(branch: string): string {
  return branch.replace(/\//g, '--')
}

const sepOf = (platform: Platform) => (platform === 'win32' ? '\\' : '/')

function normalizeSeparators(path: string, platform: Platform): string {
  const sep = sepOf(platform)
  const unified = platform === 'win32' ? path.replace(/\//g, '\\') : path.replace(/\\/g, '/')
  // 선두 UNC(`\\server`)는 보존하고 나머지 중복 구분자만 접는다
  const head = unified.startsWith(sep + sep) ? sep + sep : ''
  const rest = unified.slice(head.length)
  return head + rest.replace(sep === '\\' ? /\\{2,}/g : /\/{2,}/g, sep)
}

/** 선두 '~' / '~/' 를 home 으로 치환하고 OS 구분자로 정규화 */
export function expandHome(path: string, home: string, platform: Platform): string {
  let p = path
  if (p === '~') p = home
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = `${home.replace(/[\\/]+$/, '')}/${p.slice(2)}`
  return normalizeSeparators(p, platform)
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 토큰 치환 값 정제(Windows 호환, 모든 OS 동일): 금지 문자·제어문자 제거, 끝 `.`/공백 제거, 예약어 → 뒤에 `_` */
function sanitizeSegmentValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  let v = value.replace(/["<>|:*?\x00-\x1f\x7f]/g, '').replace(/[\\/]/g, '')
  v = v.replace(/[. ]+$/, '')
  const base = v.split('.')[0]
  if (WINDOWS_RESERVED.test(base)) v = base + '_' + v.slice(base.length)
  return v
}

/** worktreePath / mainClonePath 렌더 (토큰 치환 + 세그먼트 정제 + '~' 확장 + 구분자 정규화) */
export function renderPath(template: string, ctx: PathContext): string {
  const values: Record<string, string> = {
    owner: ctx.owner,
    repo: ctx.repo,
    branch: branchDir(ctx.branch),
    key: ctx.key,
    number: ctx.number === null ? '' : String(ctx.number),
    slug: ctx.slug,
  }
  const rendered = template.replace(/\{(owner|repo|branch|key|number|slug)\}/g, (_m, k: string) =>
    sanitizeSegmentValue(values[k]),
  )
  return expandHome(rendered, ctx.home, ctx.platform)
}

/** 경로 비교용 정규화: 구분자 통일 + '..'/'.' 정리 + (win32) 대소문자 무시 */
export function normalizePath(path: string, platform: Platform): string {
  const unified = path.replace(/\\/g, '/')
  const absolute = unified.startsWith('/')
  const out: string[] = []
  for (const part of unified.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  let joined = (absolute ? '/' : '') + out.join('/')
  if (joined === '') joined = absolute ? '/' : '.'
  if (platform === 'win32') joined = joined.toLowerCase().replace(/\//g, '\\')
  return joined
}

/** child 가 parent 와 같거나 그 하위인지 (EC-23·EC-09·worktreePathMap 비교) */
export function isSameOrInside(child: string, parent: string, platform: Platform): boolean {
  const c = normalizePath(child, platform)
  const p = normalizePath(parent, platform)
  if (c === p) return true
  const sep = sepOf(platform)
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}
