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

const notImplemented = (): never => {
  throw new Error('not implemented')
}

// STUB (Phase 6.1 Red) — 시그니처만 유지, 6.2 에서 구현
/** git ref 규칙표(서버 검증 규칙과 동일) 통과 여부 */
export function isValidRef(_ref: string): boolean {
  return notImplemented()
}
/** {slug}: 소문자 → ASCII 외 제거 → [^a-z0-9]+ → '-' → 양끝 '-' 제거 → ≤40 → 비면 'issue' */
export function slug(_title: string): string {
  return notImplemented()
}
/** {title}: 공백 → '-', ref 금지 문자 제거, 대소문자 유지, ≤60, 비면 'issue' */
export function titleToken(_title: string): string {
  return notImplemented()
}
/** branchTemplate 렌더 + ref 최종 정제. 결과가 etcBranchName 과 같으면 TemplateError('branch_conflicts_etc') */
export function renderBranch(_template: string, _issue: BranchIssue, _opts?: RenderBranchOptions): string {
  return notImplemented()
}
/** 브랜치명 → 디렉터리명 ('/' → '--') */
export function branchDir(_branch: string): string {
  return notImplemented()
}
/** 선두 '~' / '~/' 를 home 으로 치환하고 OS 구분자로 정규화 */
export function expandHome(_path: string, _home: string, _platform: Platform): string {
  return notImplemented()
}
/** worktreePath / mainClonePath 렌더 (토큰 치환 + 세그먼트 정제 + '~' 확장 + 구분자 정규화) */
export function renderPath(_template: string, _ctx: PathContext): string {
  return notImplemented()
}
/** 경로 비교용 정규화: 구분자 통일 + '..'/'.' 정리 + (win32) 대소문자 무시 */
export function normalizePath(_path: string, _platform: Platform): string {
  return notImplemented()
}
/** child 가 parent 와 같거나 그 하위인지 (EC-23·EC-09·worktreePathMap 비교) */
export function isSameOrInside(_child: string, _parent: string, _platform: Platform): boolean {
  return notImplemented()
}
