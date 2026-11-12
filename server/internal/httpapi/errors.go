package httpapi

import "net/http"

// ErrorCode 는 에러 body `{"error": <code>}` 값이다. 정본: Integration Contract v2.7 `ErrorCode` union(1:1).
type ErrorCode string

const (
	CodeUnauthorized             ErrorCode = "unauthorized"
	CodeNotFound                 ErrorCode = "not_found"
	CodeMethodNotAllowed         ErrorCode = "method_not_allowed"
	CodeInternal                 ErrorCode = "internal"
	CodePayloadTooLarge          ErrorCode = "payload_too_large"
	CodeInvalidJSON              ErrorCode = "invalid_json"
	CodeInvalidPathParam         ErrorCode = "invalid_path_param"
	CodeGitHubOAuthNotConfigured ErrorCode = "github_oauth_not_configured"
	CodeAccessDenied             ErrorCode = "access_denied"
	CodeDeviceCodeExpired        ErrorCode = "device_code_expired"
	CodeLoginFailed              ErrorCode = "login_failed"
	CodeForbiddenOrigin          ErrorCode = "forbidden_origin"
	CodeGitHubUnavailable        ErrorCode = "github_unavailable"
	CodeGlobalRequiresAllFields  ErrorCode = "global_requires_all_fields"
	CodeInvalidTemplate          ErrorCode = "invalid_template"
	CodeInvalidPathTemplate      ErrorCode = "invalid_path_template"
	CodeScriptTooLarge           ErrorCode = "script_too_large"
	CodeInvalidSparsePaths       ErrorCode = "invalid_sparse_paths"
	CodeInvalidVisibleRepos      ErrorCode = "invalid_visible_repos"
	CodeInvalidCLICode           ErrorCode = "invalid_cli_code"
	CodeInvalidIssueKey          ErrorCode = "invalid_issue_key"
	CodeBodyTooLarge             ErrorCode = "body_too_large"
	CodeInvalidBaseUpdatedAt     ErrorCode = "invalid_base_updated_at"
	CodeConflict                 ErrorCode = "conflict"
)

// apiError 는 핸들러 내부 검증 실패를 응답으로 옮기기 위한 값이다.
type apiError struct {
	status int
	code   ErrorCode
	field  string
}

func badRequest(code ErrorCode, field string) *apiError {
	return &apiError{status: http.StatusBadRequest, code: code, field: field}
}

// errorBody 는 계약 공통 에러 body 다. field 는 있을 때만 직렬화한다.
type errorBody struct {
	Error ErrorCode `json:"error"`
	Field string    `json:"field,omitempty"`
}

func writeError(w http.ResponseWriter, status int, code ErrorCode, field string) {
	writeJSON(w, status, errorBody{Error: code, Field: field})
}

func writeAPIError(w http.ResponseWriter, e *apiError) {
	writeError(w, e.status, e.code, e.field)
}
