// Integration Contract v2.4 "타입" 블록 그대로. 필드 추가만 허용(Breaking 없음).
export type SettingsValues = {
  branchTemplate: string
  etcBranchName: string
  worktreePath: string
  mainClonePath: string
  postCreateScript: string
}
export type SettingsField = keyof SettingsValues
// 전역은 null 없음
export type SettingsRecord = { [K in keyof SettingsValues]: SettingsValues[K] | null } & { updatedAt: string | null }
// 전역 PUT 은 5개 모두 string
export type SettingsInput = { [K in keyof SettingsValues]?: string | null }
export type SettingsSource = 'global' | 'org' | 'project'
export type Effective = { values: SettingsValues; sources: Record<keyof SettingsValues, SettingsSource> }
export type Me = { id: string; githubLogin: string; avatarUrl: string | null }
export type Notes = { body: string; updatedAt: string | null }
export type NotesInput = { body: string; baseUpdatedAt?: string | null }
export type ErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'method_not_allowed'
  | 'internal'
  | 'payload_too_large'
  | 'invalid_json'
  | 'invalid_path_param'
  | 'github_oauth_not_configured'
  | 'invalid_state'
  | 'missing_code'
  | 'access_denied'
  | 'invalid_code'
  | 'github_unavailable'
  | 'global_requires_all_fields'
  | 'invalid_template'
  | 'invalid_path_template'
  | 'script_too_large'
  | 'invalid_issue_key'
  | 'body_too_large'
  | 'invalid_base_updated_at'
  | 'conflict'
export type ApiErrorCode = ErrorCode | 'network_error' | 'server_error'
export type DeepLinkError = 'invalid_state' | 'access_denied' | 'invalid_code' | 'missing_code' | 'github_unavailable' | 'internal'

export type SettingsScope =
  | { kind: 'global' }
  | { kind: 'org'; owner: string }
  | { kind: 'project'; owner: string; repo: string }

export type LoginStart = { authorizeUrl: string; state: string }
export type GithubToken = { accessToken: string }
export type Health = { status: 'ok' }
/** me/getGithubToken/logout 전용: 로그인 확정 전 후보 세션 검증(CT-35) */
export type TokenOverride = { token?: string }
