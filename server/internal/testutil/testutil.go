// Package testutil 은 핸들러 테스트용 서버 조립 헬퍼다.
//
// 기대 동작(6.2 구현 대상):
//   - NewTestServer(t, opts...): db.OpenMemory() + httptest githubmock.NewHandler() + httpapi.NewHandler 를 조립한다.
//     기본 Config: PublicURL "http://127.0.0.1:8787", DeepLink "minmo://auth", GitHub*Base = mock URL,
//     GitHubClientID/Secret "test-client"/"test-secret", TokenKey 32B, CORSOrigins = 계약 기본 4종,
//     HTTPClient = mock 서버 client. opts 는 이 Config 를 수정한다. 모든 자원은 t.Cleanup 으로 정리한다.
//   - 시계: 기본 2026-11-09T12:00:00Z 고정. Now/SetNow/Advance 로 조작(동시 접근 안전).
//   - Client: 리다이렉트를 따라가지 않는 http.Client.
//   - Do: API 서버 상대 경로로 요청(body 가 nil 이 아니면 Content-Type: application/json; []byte·string 은 그대로,
//     그 외는 json.Marshal). token 이 있으면 Authorization: Bearer.
//   - DoJSON: Do 후 204 이면 (204, nil), 그 외에는 JSON 본문을 map 으로 디코드(비JSON 이면 t.Fatalf).
//   - Login(code): POST /auth/github/start → callback(code, state) → 302 Location 의 session 토큰과 state 반환(실패 시 t.Fatalf).
//
// Phase 6.1 Red 스텁: 시그니처만 고정한다.
package testutil

import (
	"database/sql"
	"net/http"
	"testing"
	"time"

	"github.com/kangmomin/minmo-cli/server/internal/httpapi"
)

// Server 는 조립된 테스트 서버다.
type Server struct {
	URL       string // API 서버 base URL
	GitHubURL string // githubmock base URL
	DB        *sql.DB
	Client    *http.Client
	t         *testing.T
}

// NewTestServer 는 테스트 서버를 조립한다.
func NewTestServer(t *testing.T, opts ...func(*httpapi.Config)) *Server {
	t.Helper()
	t.Fatal("testutil.NewTestServer: not implemented")
	return nil
}

// Now 는 주입 시계의 현재 값을 반환한다.
func (s *Server) Now() time.Time { return time.Time{} }

// SetNow 는 주입 시계를 설정한다.
func (s *Server) SetNow(tm time.Time) {}

// Advance 는 주입 시계를 d 만큼 이동한다.
func (s *Server) Advance(d time.Duration) {}

// Do 는 API 서버에 요청하고 응답과 본문을 반환한다.
func (s *Server) Do(method, path, token string, body any, hdr map[string]string) (*http.Response, []byte) {
	return nil, nil
}

// DoJSON 은 Do 후 JSON 본문을 디코드한다.
func (s *Server) DoJSON(method, path, token string, body any) (int, map[string]any) {
	return 0, nil
}

// Login 은 githubmock code 로 로그인해 세션 토큰과 state 를 반환한다.
func (s *Server) Login(code string) (token, state string) {
	return "", ""
}
