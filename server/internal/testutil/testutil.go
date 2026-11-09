// Package testutil 은 핸들러 테스트용 서버 조립 헬퍼다.
//
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
package testutil

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kangmomin/minmo-cli/server/internal/config"
	"github.com/kangmomin/minmo-cli/server/internal/db"
	"github.com/kangmomin/minmo-cli/server/internal/githubmock"
	"github.com/kangmomin/minmo-cli/server/internal/httpapi"
)

// Server 는 조립된 테스트 서버다.
type Server struct {
	URL       string // API 서버 base URL
	GitHubURL string // githubmock base URL
	DB        *sql.DB
	Client    *http.Client
	t         *testing.T

	mu  sync.Mutex
	now time.Time
}

// NewTestServer 는 테스트 서버를 조립한다.
func NewTestServer(t *testing.T, opts ...func(*httpapi.Config)) *Server {
	t.Helper()
	s := &Server{t: t, now: time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)}

	gh := httptest.NewServer(githubmock.NewHandler())
	t.Cleanup(gh.Close)
	s.GitHubURL = gh.URL

	conn, err := db.OpenMemory()
	if err != nil {
		t.Fatalf("db.OpenMemory: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	s.DB = conn

	cfg := httpapi.Config{
		PublicURL:          "http://127.0.0.1:8787",
		DeepLink:           "minmo://auth",
		GitHubOAuthBase:    gh.URL,
		GitHubAPIBase:      gh.URL,
		GitHubClientID:     "test-client",
		GitHubClientSecret: "test-secret",
		TokenKey:           bytes.Repeat([]byte{0x24}, 32),
		CORSOrigins:        append([]string(nil), config.DefaultCORSOrigins...),
		HTTPClient:         gh.Client(),
	}
	for _, o := range opts {
		o(&cfg)
	}

	api := httptest.NewServer(httpapi.NewHandler(cfg, conn, s.Now))
	t.Cleanup(api.Close)
	s.URL = api.URL
	s.Client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return s
}

// Now 는 주입 시계의 현재 값을 반환한다.
func (s *Server) Now() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.now
}

// SetNow 는 주입 시계를 설정한다.
func (s *Server) SetNow(tm time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.now = tm
}

// Advance 는 주입 시계를 d 만큼 이동한다.
func (s *Server) Advance(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.now = s.now.Add(d)
}

// Do 는 API 서버에 요청하고 응답과 본문을 반환한다.
func (s *Server) Do(method, path, token string, body any, hdr map[string]string) (*http.Response, []byte) {
	s.t.Helper()
	var rd io.Reader
	if body != nil {
		switch b := body.(type) {
		case []byte:
			rd = bytes.NewReader(b)
		case string:
			rd = strings.NewReader(b)
		default:
			j, err := json.Marshal(b)
			if err != nil {
				s.t.Fatalf("marshal body: %v", err)
			}
			rd = bytes.NewReader(j)
		}
	}
	req, err := http.NewRequest(method, s.URL+path, rd)
	if err != nil {
		s.t.Fatalf("new request %s %s: %v", method, path, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := s.Client.Do(req)
	if err != nil {
		s.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		s.t.Fatalf("%s %s: read body: %v", method, path, err)
	}
	return resp, b
}

// DoJSON 은 Do 후 JSON 본문을 디코드한다.
func (s *Server) DoJSON(method, path, token string, body any) (int, map[string]any) {
	s.t.Helper()
	resp, b := s.Do(method, path, token, body, nil)
	if resp.StatusCode == http.StatusNoContent {
		return resp.StatusCode, nil
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		s.t.Fatalf("%s %s: status %d non-JSON body %q", method, path, resp.StatusCode, truncate(b))
	}
	return resp.StatusCode, m
}

// Login 은 githubmock code 로 로그인해 세션 토큰과 state 를 반환한다.
func (s *Server) Login(code string) (token, state string) {
	s.t.Helper()
	status, m := s.DoJSON("POST", "/auth/github/start", "", nil)
	state, _ = m["state"].(string)
	if status != http.StatusOK || state == "" {
		s.t.Fatalf("login start: %d %v", status, m)
	}
	resp, b := s.Do("GET", "/auth/github/callback?"+url.Values{"code": {code}, "state": {state}}.Encode(), "", nil, nil)
	if resp.StatusCode != http.StatusFound {
		s.t.Fatalf("login callback: %d %q", resp.StatusCode, truncate(b))
	}
	loc, err := url.Parse(resp.Header.Get("Location"))
	if err != nil {
		s.t.Fatalf("login callback Location %q: %v", resp.Header.Get("Location"), err)
	}
	token = loc.Query().Get("session")
	if token == "" {
		s.t.Fatalf("login callback Location without session: %q", resp.Header.Get("Location"))
	}
	return token, state
}

func truncate(b []byte) string {
	const max = 512
	if len(b) > max {
		return string(b[:max]) + "…"
	}
	return string(b)
}
