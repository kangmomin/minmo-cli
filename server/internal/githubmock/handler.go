// Package githubmock 은 테스트·E2E 용 GitHub OAuth/API mock 이다(testutil 과 cmd/githubmock 공용).
//
// 기대 동작(6.2 구현 대상):
//   - GET  /login/oauth/authorize?redirect_uri&state&code_challenge&code_challenge_method=S256
//     → 302 `{redirect_uri}?code=<발급 code>&state=<state>`. 발급 code 는 code_challenge 에 묶이고 사용자 octocat 으로 교환된다.
//   - POST /login/oauth/access_token (form 또는 JSON: code, code_verifier, client_id, client_secret)
//     · authorize 로 발급된 code: S256(code_verifier) == code_challenge 일 때만 TokenOK, 아니면 bad_verification_code
//     · CodeOK → TokenOK, CodeUser2 → TokenUser2 (PKCE 검사 없음)
//     · CodeGitHubDown → HTTP 500
//     · 그 외 → 200 `{"error":"bad_verification_code"}`
//   - GET  /user (Authorization: Bearer|token <access token>)
//     · TokenOK → {id: 583231, login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4"}
//     · TokenUser2 → {id: 480938, login: "hubot", avatar_url: null}
//     · 그 외 → 401
//
// Phase 6.1 Red 스텁: 상수·시그니처만 고정한다.
package githubmock

import "net/http"

const (
	CodeOK         = "mock-code-ok"
	CodeUser2      = "mock-code-user2"
	CodeGitHubDown = "mock-code-5xx"

	TokenOK    = "gho_mock_token"
	TokenUser2 = "gho_mock_token2"
)

// NewHandler 는 GitHub mock http.Handler 를 만든다.
func NewHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not implemented", http.StatusNotImplemented)
	})
}
