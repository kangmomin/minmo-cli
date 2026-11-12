package httpapi_test

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
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

// startDevice 는 E1 을 호출해 응답을 돌려준다(성공해야 한다).
func startDevice(t *testing.T, s *testutil.Server) map[string]any {
	t.Helper()
	status, m := s.DoJSON("POST", "/auth/github/device/start", "", nil)
	if status != 200 {
		t.Fatalf("device start: %d %v", status, m)
	}
	return m
}

func pollDevice(s *testutil.Server, deviceID string) (int, map[string]any) {
	return s.DoJSON("POST", "/auth/github/device/poll", "", map[string]string{"deviceId": deviceID})
}

func countRows(t *testing.T, s *testutil.Server, table string) int {
	t.Helper()
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

// E1: 사용자 코드·확인 주소·간격을 돌려주고, GitHub 의 device_code 는 내주지 않는다. deviceId 는 매번 다르다
func TestAuth_DeviceStart(t *testing.T) {
	s := testutil.NewTestServer(t)
	m := startDevice(t, s)
	if len(m) != 5 {
		t.Errorf("keys: %v", m)
	}
	id, _ := m["deviceId"].(string)
	if !reSession.MatchString(id) {
		t.Errorf("deviceId %q", id)
	}
	if m["userCode"] != githubmock.UserCode || m["verificationUri"] != s.GitHubURL+"/login/device" {
		t.Errorf("start %v", m)
	}
	if m["expiresIn"] != float64(900) || m["interval"] != float64(1) {
		t.Errorf("expiresIn/interval %v", m)
	}
	for _, v := range m {
		if str, ok := v.(string); ok && strings.HasPrefix(str, "mock-device-") {
			t.Errorf("device_code leaked: %v", m)
		}
	}
	if other, _ := startDevice(t, s)["deviceId"].(string); other == id {
		t.Errorf("deviceId reused: %q", id)
	}
}

// Client ID 가 없으면 503, Device Flow 를 켜지 않은 OAuth App 이면 502
func TestAuth_DeviceStartNotConfigured(t *testing.T) {
	s := testutil.NewTestServer(t, func(c *httpapi.Config) { c.GitHubClientID = "" })
	status, m := s.DoJSON("POST", "/auth/github/device/start", "", nil)
	expectErr(t, status, m, 503, "github_oauth_not_configured", "")

	s = testutil.NewTestServer(t, func(c *httpapi.Config) { c.GitHubClientID = githubmock.ClientDisabled })
	status, m = s.DoJSON("POST", "/auth/github/device/start", "", nil)
	expectErr(t, status, m, 502, "github_unavailable", "")
}

// E2 성공: 세션 토큰을 돌려주고 사용자·세션·기본 설정을 만든다. GitHub 토큰은 암호화해 저장하고, 같은 deviceId 는 다시 쓸 수 없다
func TestAuth_DevicePollSuccess(t *testing.T) {
	s := testutil.NewTestServer(t)
	id, _ := startDevice(t, s)["deviceId"].(string)
	status, m := pollDevice(s, id)
	token, _ := m["session"].(string)
	if status != 200 || m["status"] != "ok" || !reSession.MatchString(token) || len(m) != 2 {
		t.Fatalf("poll %d %v", status, m)
	}
	if n := countRows(t, s, "users"); n != 1 {
		t.Errorf("users = %d", n)
	}
	if n := countRows(t, s, "sessions"); n != 1 {
		t.Errorf("sessions = %d", n)
	}
	var enc []byte
	if err := s.DB.QueryRow(`SELECT access_token_enc FROM users`).Scan(&enc); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(enc), githubmock.TokenOK) {
		t.Errorf("access token stored in plaintext")
	}
	if status, m := s.DoJSON("GET", "/me", token, nil); status != 200 || m["githubLogin"] != "octocat" {
		t.Errorf("/me %d %v", status, m)
	}
	// 1회용
	status, m = pollDevice(s, id)
	expectErr(t, status, m, 400, "device_code_expired", "")
}

// 승인 전에는 pending, 확인 간격은 서버가 지킨다(너무 이른 확인은 GitHub 에 묻지 않는다)
func TestAuth_DevicePollPendingAndInterval(t *testing.T) {
	s := testutil.NewTestServer(t)
	s.SetNextDevice(githubmock.CodePending) // GitHub 확인 3번째에 승인
	id, _ := startDevice(t, s)["deviceId"].(string)

	status, m := pollDevice(s, id) // GitHub 확인 1
	if status != 200 || m["status"] != "pending" || m["interval"] != float64(1) || m["session"] != nil {
		t.Fatalf("first poll %d %v", status, m)
	}
	// 간격이 지나기 전: GitHub 에 묻지 않으므로 몇 번을 물어도 승인까지 남은 횟수가 줄지 않는다
	for i := 0; i < 5; i++ {
		if status, m = pollDevice(s, id); status != 200 || m["status"] != "pending" {
			t.Fatalf("early poll %d %v", status, m)
		}
	}
	s.Advance(time.Second)
	if status, m = pollDevice(s, id); m["status"] != "pending" { // GitHub 확인 2
		t.Fatalf("second poll %d %v", status, m)
	}
	s.Advance(time.Second)
	if status, m = pollDevice(s, id); status != 200 || m["status"] != "ok" { // GitHub 확인 3
		t.Fatalf("third poll %d %v", status, m)
	}
	if n := countRows(t, s, "sessions"); n != 1 {
		t.Errorf("sessions = %d", n)
	}
}

// GitHub 가 slow_down 을 주면 간격을 늘려 알려 주고, 그 간격이 지나야 다시 묻는다
func TestAuth_DevicePollSlowDown(t *testing.T) {
	s := testutil.NewTestServer(t)
	s.SetNextDevice(githubmock.CodeSlowDown)
	id, _ := startDevice(t, s)["deviceId"].(string)
	status, m := pollDevice(s, id)
	if status != 200 || m["status"] != "pending" || m["interval"] != float64(10) {
		t.Fatalf("slow_down poll %d %v", status, m)
	}
	s.Advance(9 * time.Second)
	if _, m = pollDevice(s, id); m["status"] != "pending" {
		t.Fatalf("before new interval: %v", m)
	}
	s.Advance(time.Second)
	if _, m = pollDevice(s, id); m["status"] != "ok" {
		t.Fatalf("after new interval: %v", m)
	}
}

// 거부·만료·모르는 id·서버 쪽 만료 → 오류 코드, 세션 미발급
func TestAuth_DevicePollErrors(t *testing.T) {
	s := testutil.NewTestServer(t)
	for _, c := range []struct{ next, code string }{{githubmock.CodeDenied, "access_denied"}, {githubmock.CodeExpired, "device_code_expired"}} {
		s.SetNextDevice(c.next)
		id, _ := startDevice(t, s)["deviceId"].(string)
		status, m := pollDevice(s, id)
		expectErr(t, status, m, 400, c.code, "")
		// 끝난 로그인은 지워진다
		status, m = pollDevice(s, id)
		expectErr(t, status, m, 400, "device_code_expired", "")
	}
	status, m := pollDevice(s, "nope")
	expectErr(t, status, m, 400, "device_code_expired", "")
	status, m = s.DoJSON("POST", "/auth/github/device/poll", "", map[string]any{})
	expectErr(t, status, m, 400, "device_code_expired", "")
	resp, b := s.Do("POST", "/auth/github/device/poll", "", "not json", nil)
	if resp.StatusCode != 400 || !strings.Contains(string(b), "invalid_json") {
		t.Errorf("bad body: %d %q", resp.StatusCode, b)
	}

	// 15분(expires_in)이 지나면 GitHub 에 묻지 않고 만료로 답한다
	s.SetNextDevice(githubmock.CodePending)
	id, _ := startDevice(t, s)["deviceId"].(string)
	s.Advance(900 * time.Second)
	status, m = pollDevice(s, id)
	expectErr(t, status, m, 400, "device_code_expired", "")
	if n := countRows(t, s, "sessions"); n != 0 {
		t.Errorf("sessions = %d, want 0", n)
	}
}

// GitHub 토큰 확인이 일시 실패(5xx)하면 502 로 답하되 로그인은 살려 둔다
func TestAuth_DevicePollGitHubDown(t *testing.T) {
	s := testutil.NewTestServer(t)
	s.SetNextDevice(githubmock.CodeGitHubDown)
	id, _ := startDevice(t, s)["deviceId"].(string)
	status, m := pollDevice(s, id)
	expectErr(t, status, m, 502, "github_unavailable", "")
	// 지워지지 않았다: 간격 전에는 pending 으로 답한다
	if status, m = pollDevice(s, id); status != 200 || m["status"] != "pending" {
		t.Errorf("after 5xx: %d %v", status, m)
	}
}

// 같은 사용자의 재로그인은 사용자 행을 늘리지 않는다
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

// GitHub 에 닿지 못하면 E1 은 502
func TestAuth_GitHubUnreachable_F01(t *testing.T) {
	s := testutil.NewTestServer(t, func(c *httpapi.Config) {
		c.GitHubOAuthBase = "http://127.0.0.1:1"
		c.GitHubAPIBase = "http://127.0.0.1:1"
	})
	status, m := s.DoJSON("POST", "/auth/github/device/start", "", nil)
	expectErr(t, status, m, 502, "github_unavailable", "")
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
