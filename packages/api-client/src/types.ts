// Integration Contract v2.7 "타입" 블록 그대로. 필드 추가만 허용(Breaking 없음).
export type SettingsValues = {
  branchTemplate: string
  etcBranchName: string
  worktreePath: string
  mainClonePath: string
  postCreateScript: string
  /** v2.6: 줄바꿈 구분 sparse-checkout 디렉터리, "" = 전체 체크아웃 */
  sparsePaths: string
  /** v2.7: Linux/macOS(sh) 생성 후 스크립트. postCreateScript 는 Windows(PowerShell) 용 */
  postCreateScriptPosix: string
}
export type SettingsField = keyof SettingsValues
// 전역은 null 없음
export type SettingsRecord = { [K in keyof SettingsValues]: SettingsValues[K] | null } & { updatedAt: string | null }
// 전역 PUT 은 5개 필드가 string 필수, sparsePaths·postCreateScriptPosix 는 생략·null 이면 저장값 유지(없으면 "")
export type SettingsInput = { [K in keyof SettingsValues]?: string | null }
export type SettingsSource = 'global' | 'org' | 'project'
export type Effective = { values: SettingsValues; sources: Record<keyof SettingsValues, SettingsSource> }
export type Me = { id: string; githubLogin: string; avatarUrl: string | null }
export type Notes = { body: string; updatedAt: string | null }
export type NotesInput = { body: string; baseUpdatedAt?: string | null }
/** v2.7: 보일 저장소. repos null = 전체 표시, 원소는 소문자 "owner/repo" 또는 "owner/*" */
export type VisibleRepos = { repos: string[] | null; updatedAt: string | null }
export type VisibleReposInput = { repos: string[] | null; baseUpdatedAt?: string | null }
/** v2.7: 원격 CLI 1회용 로그인 코드(10분) */
export type CliCode = { code: string; expiresAt: string }
export type CliExchange = { session: string }
export type SessionKind = 'desktop' | 'cli'
export type SessionInfo = { id: string; kind: SessionKind; label: string | null; createdAt: string; lastUsedAt: string | null; current: boolean }
export type Sessions = { sessions: SessionInfo[] }
export type ErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'method_not_allowed'
  | 'internal'
  | 'payload_too_large'
  | 'invalid_json'
  | 'invalid_path_param'
  | 'github_oauth_not_configured'
  | 'access_denied'
  | 'device_code_expired'
  | 'login_failed'
  | 'forbidden_origin'
  | 'github_unavailable'
  | 'global_requires_all_fields'
  | 'invalid_template'
  | 'invalid_path_template'
  | 'script_too_large'
  | 'invalid_sparse_paths'
  | 'invalid_visible_repos'
  | 'invalid_cli_code'
  | 'invalid_issue_key'
  | 'body_too_large'
  | 'invalid_base_updated_at'
  | 'conflict'
export type ApiErrorCode = ErrorCode | 'network_error' | 'server_error' | 'http_error'

export type SettingsScope =
  | { kind: 'global' }
  | { kind: 'org'; owner: string }
  | { kind: 'project'; owner: string; repo: string }

/** 기기 코드 로그인 시작(E1). 사용자가 verificationUri 에서 userCode 를 입력해 승인한다. expiresIn·interval 은 초 */
export type DeviceLoginStart = { deviceId: string; userCode: string; verificationUri: string; expiresIn: number; interval: number }
/** 승인 확인(E2). pending 이면 interval 초 뒤에 다시 확인한다 */
export type DeviceLoginPoll = { status: 'pending'; interval: number } | { status: 'ok'; session: string }
export type GithubToken = { accessToken: string }
export type Health = { status: 'ok' }
/** me/getGithubToken/logout 전용: 로그인 확정 전 후보 세션 검증(CT-35) */
export type TokenOverride = { token?: string }
