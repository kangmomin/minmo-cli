package httpapi_test

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/kangmomin/minmo-cli/server/internal/githubmock"
	"github.com/kangmomin/minmo-cli/server/internal/httpapi"
	"github.com/kangmomin/minmo-cli/server/internal/testutil"
)

var (
	reUserID  = regexp.MustCompile(`^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	reSession = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

func startLogin(t *testing.T, s *testutil.Server) (authorizeURL, state string) {
	t.Helper()
	status, m := s.DoJSON("POST", "/auth/github/start", "", nil)
	if status != 200 {
		t.Fatalf("start: %d %v", status, m)
	}
	authorizeURL, _ = m["authorizeUrl"].(string)
	state, _ = m["state"].(string)
	if authorizeURL == "" || state == "" {
		t.Fatalf("start: %v", m)
	}
	return authorizeURL, state
}

func callback(s *testutil.Server, q url.Values) (*http.Response, string) {
	resp, b := s.Do("GET", "/auth/github/callback?"+q.Encode(), "", nil, nil)
	return resp, string(b)
}

// expectHTMLError 는 E2 실패 응답(HTML + meta refresh 딥링크 error)을 단언한다.
func expectHTMLError(t *testing.T, resp *http.Response, body string, wantStatus int, code, state string) {
	t.Helper()
	if resp.StatusCode != wantStatus {
		t.Errorf("%s: status %d, want %d", code, resp.StatusCode, wantStatus)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("%s: Content-Type %q, want text/html", code, ct)
	}
	if resp.Header.Get("Location") != "" {
		t.Errorf("%s: failure must not redirect (Location %q)", code, resp.Header.Get("Location"))
	}
	lower := strings.ToLower(body)
	if !strings.Contains(lower, "http-equiv") || !strings.Contains(lower, "refresh") {
		t.Errorf("%s: body lacks meta refresh: %q", code, body)
	}
	link := "minmo://auth?error=" + code
	if state != "" {
		link += "&state=" + state
	}
	if !strings.Contains(body, link) && !strings.Contains(body, strings.ReplaceAll(link, "&", "&amp;")) {
		t.Errorf("%s: body lacks deep link %q: %q", code, link, body)
	}
}

func countRows(t *testing.T, s *testutil.Server, table string) int {
	t.Helper()
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

// CT-01: authorizeUrl 구성 · state 는 매 호출 고유
func TestAuth_Start_CT01(t *testing.T) {
	s := testutil.NewTestServer(t)
	a1, st1 := startLogin(t, s)
	_, st2 := startLogin(t, s)
	if st1 == st2 {
		t.Errorf("state must be unique per start")
	}
	u, err := url.Parse(a1)
	if err != nil {
		t.Fatalf("parse %q: %v", a1, err)
	}
	if got := u.Scheme + "://" + u.Host + u.Path; got != s.GitHubURL+"/login/oauth/authorize" {
		t.Errorf("authorize endpoint %q", got)
	}
	q := u.Query()
	want := map[string]string{
		"client_id":             "test-client",
		"redirect_uri":          "http://127.0.0.1:8787/auth/github/callback",
		"state":                 st1,
		"code_challenge_method": "S256",
	}
	for k, v := range want {
		if q.Get(k) != v {
			t.Errorf("%s=%q, want %q", k, q.Get(k), v)
		}
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(q.Get("code_challenge")) {
		t.Errorf("code_challenge %q is not base64url(sha256)", q.Get("code_challenge"))
	}
	scopes := strings.Fields(q.Get("scope"))
	for _, sc := range []string{"repo", "read:org", "read:user"} {
		found := false
		for _, x := range scopes {
			found = found || x == sc
		}
		if !found {
			t.Errorf("scope %q lacks %s", q.Get("scope"), sc)
		}
	}
}

// F-01(E1): client id 미설정 → 503 github_oauth_not_configured
func TestAuth_StartNotConfigured_F01(t *testing.T) {
	s := testutil.NewTestServer(t, func(c *httpapi.Config) { c.GitHubClientID = ""; c.GitHubClientSecret = "" })
	status, m := s.DoJSON("POST", "/auth/github/start", "", nil)
	expectErr(t, status, m, 503, "github_oauth_not_configured", "")
}

// CT-01·CT-02 / F-01: PKCE 왕복 — mock authorize 가 발급한 code 는 서버가 보낸 verifier 가 challenge 와 맞아야 교환된다
func TestAuth_PKCERoundTrip_CT01_CT02(t *testing.T) {
	s := testutil.NewTestServer(t)
	authorizeURL, state := startLogin(t, s)
	resp, err := s.Client.Get(authorizeURL)
	if err != nil {
		t.Fatalf("mock authorize: %v", err)
	}
	resp.Body.Close()
	redirect, err := url.Parse(resp.Header.Get("Location"))
	if err != nil || resp.StatusCode != http.StatusFound {
		t.Fatalf("mock authorize: %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	code := redirect.Query().Get("code")
	if redirect.Query().Get("state") != state || code == "" {
		t.Fatalf("mock redirect %q", redirect)
	}
	cb, body := callback(s, url.Values{"code": {code}, "state": {state}})
	if cb.StatusCode != http.StatusFound || !strings.HasPrefix(cb.Header.Get("Location"), "minmo://auth?session=") {
		t.Errorf("callback with PKCE code: %d Location %q body %q", cb.StatusCode, cb.Header.Get("Location"), body)
	}
}

// CT-02·CT-36 / F-01: 성공 콜백 302 + session·state, 세션은 해시로만 저장, GitHub 토큰은 암호화 저장, 전역 기본 설정 행 생성
func TestAuth_CallbackSuccess_CT02_CT36(t *testing.T) {
	s := testutil.NewTestServer(t)
	_, state := startLogin(t, s)
	resp, body := callback(s, url.Values{"code": {githubmock.CodeOK}, "state": {state}})
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status %d body %q", resp.StatusCode, body)
	}
	if body != "" {
		t.Errorf("302 body must be empty: %q", body)
	}
	loc, err := url.Parse(resp.Header.Get("Location"))
	if err != nil || loc.Scheme != "minmo" || loc.Host != "auth" {
		t.Fatalf("Location %q", resp.Header.Get("Location"))
	}
	token := loc.Query().Get("session")
	if !reSession.MatchString(token) {
		t.Errorf("session %q", token)
	}
	if loc.Query().Get("state") != state {
		t.Errorf("Location state %q, want %q", loc.Query().Get("state"), state)
	}
	var hash string
	if err := s.DB.QueryRow(`SELECT token_hash FROM sessions`).Scan(&hash); err != nil {
		t.Fatalf("select session: %v", err)
	}
	sum := sha256.Sum256([]byte(token))
	if hash != hex.EncodeToString(sum[:]) {
		t.Errorf("sessions.token_hash is not sha256 hex of the session token")
	}
	var enc []byte
	if err := s.DB.QueryRow(`SELECT access_token_enc FROM users`).Scan(&enc); err != nil {
		t.Fatalf("select user: %v", err)
	}
	if len(enc) == 0 || strings.Contains(string(enc), githubmock.TokenOK) {
		t.Errorf("access_token_enc must be encrypted (len %d)", len(enc))
	}
	var globals int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM settings WHERE scope = 'global'`).Scan(&globals); err != nil {
		t.Fatalf("count settings: %v", err)
	}
	if globals != 1 {
		t.Errorf("global settings rows = %d, want 1 after first login", globals)
	}
}

// F-01(사용자 upsert): 같은 GitHub 사용자의 재로그인 → 같은 id, users 1행, 세션 2개
func TestAuth_UserUpsert_F01(t *testing.T) {
	s := testutil.NewTestServer(t)
	t1, _ := s.Login(githubmock.CodeOK)
	t2, _ := s.Login(githubmock.CodeOK)
	_, m1 := s.DoJSON("GET", "/me", t1, nil)
	_, m2 := s.DoJSON("GET", "/me", t2, nil)
	if m1["id"] == nil || m1["id"] != m2["id"] {
		t.Errorf("ids differ: %v vs %v", m1["id"], m2["id"])
	}
	if n := countRows(t, s, "users"); n != 1 {
		t.Errorf("users = %d, want 1", n)
	}
	if n := countRows(t, s, "sessions"); n != 2 {
		t.Errorf("sessions = %d, want 2", n)
	}
	if n := countRows(t, s, "settings"); n != 1 {
		t.Errorf("settings = %d, want 1 (global defaults not duplicated)", n)
	}
}

// CT-03 / EC-04: state 불일치·누락·만료 → 400 HTML invalid_state, 세션 미발급
func TestAuth_InvalidState_CT03(t *testing.T) {
	s := testutil.NewTestServer(t)
	_, state := startLogin(t, s)
	resp, body := callback(s, url.Values{"code": {githubmock.CodeOK}, "state": {"nope"}})
	expectHTMLError(t, resp, body, 400, "invalid_state", "")
	resp, body = callback(s, url.Values{"code": {githubmock.CodeOK}})
	expectHTMLError(t, resp, body, 400, "invalid_state", "")
	if strings.Contains(body, "&state=") || strings.Contains(body, "&amp;state=") {
		t.Errorf("state unknown → deep link must omit state: %q", body)
	}
	// 불일치 시도가 유효 state 를 소비하지 않음 — 원래 state 는 여전히 사용 가능
	resp, body = callback(s, url.Values{"code": {githubmock.CodeOK}, "state": {state}})
	if resp.StatusCode != http.StatusFound {
		t.Errorf("valid state after mismatches: %d %q", resp.StatusCode, body)
	}
	// TTL 10분 경과 → 만료
	_, state = startLogin(t, s)
	s.Advance(10*time.Minute + time.Second)
	resp, body = callback(s, url.Values{"code": {githubmock.CodeOK}, "state": {state}})
	expectHTMLError(t, resp, body, 400, "invalid_state", "")
	if n := countRows(t, s, "sessions"); n != 1 {
		t.Errorf("sessions = %d, want 1 (only the valid callback)", n)
	}
}

// CT-25: 같은 state 2회 → 2번째 invalid_state
func TestAuth_StateReuse_CT25(t *testing.T) {
	s := testutil.NewTestServer(t)
	_, state := s.Login(githubmock.CodeOK)
	resp, body := callback(s, url.Values{"code": {githubmock.CodeOK}, "state": {state}})
	expectHTMLError(t, resp, body, 400, "invalid_state", "")
	if n := countRows(t, s, "sessions"); n != 1 {
		t.Errorf("sessions = %d, want 1", n)
	}
}

// CT-26·CT-36 / F-01: E2 판정 순서 — state 검증 → error 파라미터 → code 누락 → 교환 실패
func TestAuth_CallbackErrors_CT26_CT36(t *testing.T) {
	s := testutil.NewTestServer(t)
	// CT-36: state 없는 error=access_denied → invalid_state 우선
	resp, body := callback(s, url.Values{"error": {"access_denied"}})
	expectHTMLError(t, resp, body, 400, "invalid_state", "")

	cases := []struct {
		name   string
		q      func(state string) url.Values
		status int
		code   string
	}{
		{"access_denied", func(st string) url.Values { return url.Values{"error": {"access_denied"}, "state": {st}} }, 400, "access_denied"},
		{"other error param", func(st string) url.Values {
			return url.Values{"error": {"redirect_uri_mismatch"}, "state": {st}, "code": {githubmock.CodeOK}}
		}, 400, "invalid_code"},
		{"missing code", func(st string) url.Values { return url.Values{"state": {st}} }, 400, "missing_code"},
		{"bad_verification_code", func(st string) url.Values { return url.Values{"code": {"mock-code-bad"}, "state": {st}} }, 400, "invalid_code"},
		{"github 5xx", func(st string) url.Values { return url.Values{"code": {githubmock.CodeGitHubDown}, "state": {st}} }, 502, "github_unavailable"},
	}
	for _, c := range cases {
		_, state := startLogin(t, s)
		resp, body := callback(s, c.q(state))
		expectHTMLError(t, resp, body, c.status, c.code, state)
	}
	if n := countRows(t, s, "sessions"); n != 0 {
		t.Errorf("sessions = %d, want 0", n)
	}
}

// F-01(E2 ④): GitHub 연결 불가(네트워크) → 502 github_unavailable HTML
func TestAuth_CallbackGitHubUnreachable_F01(t *testing.T) {
	s := testutil.NewTestServer(t, func(c *httpapi.Config) {
		c.GitHubOAuthBase = "http://127.0.0.1:1"
		c.GitHubAPIBase = "http://127.0.0.1:1"
	})
	_, state := startLogin(t, s)
	resp, body := callback(s, url.Values{"code": {githubmock.CodeOK}, "state": {state}})
	expectHTMLError(t, resp, body, 502, "github_unavailable", state)
}

// CT-04 / EC-03: 토큰 없음·위조·형식 오류 → 401 unauthorized JSON
func TestAuth_Unauthorized_CT04(t *testing.T) {
	s := testutil.NewTestServer(t)
	for _, hdr := range []map[string]string{
		nil,
		{"Authorization": "Bearer " + strings.Repeat("A", 43)},
		{"Authorization": "Bearer "},
		{"Authorization": "Basic dXNlcjpwYXNz"},
	} {
		resp, b := s.Do("GET", "/me", "", nil, hdr)
		if resp.StatusCode != 401 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") || !strings.Contains(string(b), `"unauthorized"`) {
			t.Errorf("hdr %v: %d %q %q", hdr, resp.StatusCode, resp.Header.Get("Content-Type"), b)
		}
	}
	// 세션 토큰의 해시를 토큰으로 써도 401
	token, _ := s.Login(githubmock.CodeOK)
	sum := sha256.Sum256([]byte(token))
	status, m := s.DoJSON("GET", "/me", hex.EncodeToString(sum[:]), nil)
	expectErr(t, status, m, 401, "unauthorized", "")
}

// CT-05: /me 200 {id(usr_uuid), githubLogin, avatarUrl(string|null)} — 정확히 3키
func TestAuth_Me_CT05(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	status, m := s.DoJSON("GET", "/me", token, nil)
	if status != 200 || len(m) != 3 {
		t.Fatalf("/me %d %v", status, m)
	}
	if id, _ := m["id"].(string); !reUserID.MatchString(id) {
		t.Errorf("id %v", m["id"])
	}
	if m["githubLogin"] != "octocat" || m["avatarUrl"] != "https://avatars.githubusercontent.com/u/583231?v=4" {
		t.Errorf("/me %v", m)
	}
	token2, _ := s.Login(githubmock.CodeUser2)
	status, m = s.DoJSON("GET", "/me", token2, nil)
	if v, ok := m["avatarUrl"]; status != 200 || m["githubLogin"] != "hubot" || !ok || v != nil {
		t.Errorf("/me user2 %d %v", status, m)
	}
}

// CT-18: E4 → mock 발급 토큰 원문(사용자별)
func TestAuth_GitHubToken_CT18(t *testing.T) {
	s := testutil.NewTestServer(t)
	t1, _ := s.Login(githubmock.CodeOK)
	t2, _ := s.Login(githubmock.CodeUser2)
	for _, c := range []struct{ token, want string }{{t1, githubmock.TokenOK}, {t2, githubmock.TokenUser2}} {
		status, m := s.DoJSON("GET", "/me/github-token", c.token, nil)
		if status != 200 || m["accessToken"] != c.want || len(m) != 1 {
			t.Errorf("github-token %d %v, want %s", status, m, c.want)
		}
	}
	status, m := s.DoJSON("GET", "/me/github-token", "", nil)
	expectErr(t, status, m, 401, "unauthorized", "")
}

// CT-06: E5 → 204(본문 없음), 같은 토큰 /me·재로그아웃 401, 해당 세션 행만 삭제
func TestAuth_Logout_CT06(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	resp, b := s.Do("DELETE", "/auth/session", token, nil, nil)
	if resp.StatusCode != http.StatusNoContent || len(b) != 0 {
		t.Errorf("logout %d body %q", resp.StatusCode, b)
	}
	status, m := s.DoJSON("GET", "/me", token, nil)
	expectErr(t, status, m, 401, "unauthorized", "")
	status, m = s.DoJSON("DELETE", "/auth/session", token, nil)
	expectErr(t, status, m, 401, "unauthorized", "")
	if n := countRows(t, s, "sessions"); n != 0 {
		t.Errorf("sessions = %d, want 0", n)
	}
}
