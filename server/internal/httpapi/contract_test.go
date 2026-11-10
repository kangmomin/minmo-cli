// 공용 계약 테스트 — 오케스트레이터 소유. BE 구현 에이전트는 이 파일을 수정하지 않는다.
// Integration Contract v2.4 의 CT-nn 을 HTTP 경로로 고정한다 (fixture: ../../../contracts/fixtures).
// Red-0 시점에는 go.mod/구현이 없어 컴파일되지 않는 것이 예상 상태이며,
// 6.1 배리어 후 스텁 위에서 "컴파일 OK + 단언 실패"가 유효 Red 다.
package httpapi_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/kangmomin/minmo-cli/server/internal/db"
	"github.com/kangmomin/minmo-cli/server/internal/httpapi"
)

const ctFixtureDir = "../../../contracts/fixtures"

var (
	ctReID    = regexp.MustCompile(`^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	ctReTS    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	ctReToken = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

var ctCORSOrigins = []string{"http://localhost:1420", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"}

// ---- GitHub mock (contract_test 전용 — BE testutil 에 의존하지 않음) ----

var ctGitHubCodes = map[string]string{"ct-code-ok": "gho_ct_token", "ct-code-user2": "gho_ct_token2"}

var ctGitHubUsers = map[string]map[string]any{
	"gho_ct_token":  {"id": 583231, "login": "octocat", "avatar_url": "https://avatars.githubusercontent.com/u/583231?v=4"},
	"gho_ct_token2": {"id": 480938, "login": "hubot", "avatar_url": nil},
}

func ctGitHubHandler(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/login/oauth/access_token":
		code := ""
		if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			code = body["code"]
		} else {
			_ = r.ParseForm()
			code = r.FormValue("code")
		}
		w.Header().Set("Content-Type", "application/json")
		if tok, ok := ctGitHubCodes[code]; ok {
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": tok, "token_type": "bearer", "scope": "repo,read:org,read:user"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "bad_verification_code", "error_description": "The code passed is incorrect or expired."})
	case r.Method == http.MethodGet && r.URL.Path == "/user":
		tok := r.Header.Get("Authorization")
		tok = strings.TrimPrefix(strings.TrimPrefix(tok, "Bearer "), "token ")
		u, ok := ctGitHubUsers[tok]
		if !ok {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(u)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// ---- 환경 ----

type ctEnv struct {
	t      *testing.T
	api    *httptest.Server
	gh     *httptest.Server
	conn   *sql.DB
	now    time.Time
	client *http.Client
}

func ctNewEnv(t *testing.T) *ctEnv {
	t.Helper()
	e := &ctEnv{t: t, now: time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)}
	e.gh = httptest.NewServer(http.HandlerFunc(ctGitHubHandler))
	t.Cleanup(e.gh.Close)
	conn, err := db.OpenMemory()
	if err != nil {
		t.Fatalf("db.OpenMemory: %v", err)
	}
	e.conn = conn
	t.Cleanup(func() { _ = conn.Close() })
	cfg := httpapi.Config{
		PublicURL:          "http://127.0.0.1:8787",
		DeepLink:           "minmo://auth",
		GitHubOAuthBase:    e.gh.URL,
		GitHubAPIBase:      e.gh.URL,
		GitHubClientID:     "ct-client",
		GitHubClientSecret: "ct-secret",
		TokenKey:           bytes.Repeat([]byte{0x42}, 32),
		CORSOrigins:        ctCORSOrigins,
		HTTPClient:         e.gh.Client(),
	}
	h := httpapi.NewHandler(cfg, conn, func() time.Time { return e.now })
	e.api = httptest.NewServer(h)
	t.Cleanup(e.api.Close)
	e.client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return e
}

func (e *ctEnv) do(method, path, token string, body any, hdr map[string]string) (*http.Response, []byte) {
	e.t.Helper()
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
				e.t.Fatalf("marshal: %v", err)
			}
			rd = bytes.NewReader(j)
		}
	}
	req, err := http.NewRequest(method, e.api.URL+path, rd)
	if err != nil {
		e.t.Fatalf("request: %v", err)
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
	resp, err := e.client.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func (e *ctEnv) doJSON(method, path, token string, body any) (int, map[string]any) {
	e.t.Helper()
	resp, b := e.do(method, path, token, body, nil)
	if resp.StatusCode == http.StatusNoContent {
		return resp.StatusCode, nil
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		e.t.Errorf("%s %s: Content-Type %q, want application/json (body %q)", method, path, ct, string(b))
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		e.t.Fatalf("%s %s: non-JSON body %q", method, path, string(b))
	}
	return resp.StatusCode, m
}

func (e *ctEnv) startLogin() (authorizeURL, state string) {
	e.t.Helper()
	status, m := e.doJSON("POST", "/auth/github/start", "", nil)
	if status != 200 {
		e.t.Fatalf("start: status %d body %v", status, m)
	}
	authorizeURL, _ = m["authorizeUrl"].(string)
	state, _ = m["state"].(string)
	if authorizeURL == "" || state == "" {
		e.t.Fatalf("start: missing authorizeUrl/state: %v", m)
	}
	return authorizeURL, state
}

func (e *ctEnv) callback(q url.Values) (*http.Response, []byte) {
	e.t.Helper()
	return e.do("GET", "/auth/github/callback?"+q.Encode(), "", nil, nil)
}

func (e *ctEnv) login(code string) (token, state string) {
	e.t.Helper()
	_, state = e.startLogin()
	resp, b := e.callback(url.Values{"code": {code}, "state": {state}})
	if resp.StatusCode != http.StatusFound {
		e.t.Fatalf("callback: status %d body %q", resp.StatusCode, string(b))
	}
	loc, err := url.Parse(resp.Header.Get("Location"))
	if err != nil {
		e.t.Fatalf("callback Location parse: %v", err)
	}
	token = loc.Query().Get("session")
	if token == "" {
		e.t.Fatalf("callback Location without session: %s", resp.Header.Get("Location"))
	}
	return token, state
}

func (e *ctEnv) sessionCount() int {
	e.t.Helper()
	var n int
	if err := e.conn.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&n); err != nil {
		e.t.Fatalf("count sessions: %v", err)
	}
	return n
}

// ---- fixture 비교 ----

func ctFixture(t *testing.T, name string) any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(ctFixtureDir, name))
	if err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return v
}

func ctMatch(t *testing.T, path string, want, got any) {
	t.Helper()
	switch w := want.(type) {
	case string:
		g, ok := got.(string)
		switch w {
		case "<id>", "<ts>", "<token>", "<string>":
			if !ok {
				t.Errorf("%s: want string placeholder %s, got %v", path, w, got)
				return
			}
			var re *regexp.Regexp
			switch w {
			case "<id>":
				re = ctReID
			case "<ts>":
				re = ctReTS
			case "<token>":
				re = ctReToken
			}
			if re != nil && !re.MatchString(g) {
				t.Errorf("%s: %q does not match %s", path, g, w)
			}
			return
		}
		if !ok || g != w {
			t.Errorf("%s: want %q, got %v", path, w, got)
		}
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			t.Errorf("%s: want object, got %v", path, got)
			return
		}
		for k, wv := range w {
			gv, ok := g[k]
			if !ok {
				t.Errorf("%s.%s: missing", path, k)
				continue
			}
			ctMatch(t, path+"."+k, wv, gv)
		}
		for k := range g {
			if _, ok := w[k]; !ok {
				t.Errorf("%s.%s: unexpected field", path, k)
			}
		}
	case nil:
		if got != nil {
			t.Errorf("%s: want null, got %v", path, got)
		}
	default:
		if !reflect.DeepEqual(want, got) {
			t.Errorf("%s: want %v, got %v", path, want, got)
		}
	}
}

func ctExpectError(t *testing.T, status int, m map[string]any, wantStatus int, code, field string) {
	t.Helper()
	if status != wantStatus {
		t.Errorf("status %d, want %d (body %v)", status, wantStatus, m)
	}
	if m["error"] != code {
		t.Errorf("error %v, want %q", m["error"], code)
	}
	if field != "" && m["field"] != field {
		t.Errorf("field %v, want %q", m["field"], field)
	}
}

func ctFullGlobal(over map[string]any) map[string]any {
	m := map[string]any{
		"branchTemplate":   "issue/{number}-{slug}",
		"etcBranchName":    "etc",
		"worktreePath":     "~/minmo-workspaces/{owner}/{repo}/{branch}",
		"mainClonePath":    "~/minmo-workspaces/{owner}/{repo}/_main",
		"postCreateScript": "",
	}
	for k, v := range over {
		m[k] = v
	}
	return m
}

// ---- 인증 (CT-01~06, 18, 24~26, 36) ----

func TestCT01_StartLogin(t *testing.T) {
	e := ctNewEnv(t)
	authorizeURL, state := e.startLogin()
	if !strings.HasPrefix(authorizeURL, e.gh.URL+"/login/oauth/authorize?") {
		t.Errorf("authorizeUrl prefix: %s", authorizeURL)
	}
	u, err := url.Parse(authorizeURL)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	q := u.Query()
	if q.Get("client_id") != "ct-client" {
		t.Errorf("client_id=%q", q.Get("client_id"))
	}
	if q.Get("redirect_uri") != "http://127.0.0.1:8787/auth/github/callback" {
		t.Errorf("redirect_uri=%q", q.Get("redirect_uri"))
	}
	if q.Get("state") != state {
		t.Errorf("state in url %q != response state %q", q.Get("state"), state)
	}
	if q.Get("code_challenge_method") != "S256" {
		t.Errorf("code_challenge_method=%q", q.Get("code_challenge_method"))
	}
	if len(q.Get("code_challenge")) < 43 {
		t.Errorf("code_challenge too short: %q", q.Get("code_challenge"))
	}
	if !strings.Contains(q.Get("scope"), "repo") {
		t.Errorf("scope=%q", q.Get("scope"))
	}
}

func TestCT02_CT36_CallbackRedirect(t *testing.T) {
	e := ctNewEnv(t)
	_, state := e.startLogin()
	resp, b := e.callback(url.Values{"code": {"ct-code-ok"}, "state": {state}})
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status %d body %q", resp.StatusCode, string(b))
	}
	if len(b) != 0 {
		t.Errorf("302 body must be empty, got %q", string(b))
	}
	loc := resp.Header.Get("Location")
	if !strings.HasPrefix(loc, "minmo://auth?session=") {
		t.Errorf("Location %q", loc)
	}
	u, _ := url.Parse(loc)
	if !ctReToken.MatchString(u.Query().Get("session")) {
		t.Errorf("session token format: %q", u.Query().Get("session"))
	}
	if u.Query().Get("state") != state { // CT-36
		t.Errorf("Location state %q != %q", u.Query().Get("state"), state)
	}
}

func TestCT03_CT25_CT36_InvalidState(t *testing.T) {
	e := ctNewEnv(t)
	check := func(name string, q url.Values, code string) {
		t.Helper()
		resp, b := e.callback(q)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: status %d", name, resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Errorf("%s: Content-Type %q, want text/html", name, ct)
		}
		if !strings.Contains(string(b), code) {
			t.Errorf("%s: body lacks %q", name, code)
		}
		if !strings.Contains(string(b), "minmo://auth?error="+code) {
			t.Errorf("%s: body lacks deep link error", name)
		}
	}
	// CT-03: 불일치·누락
	_, _ = e.startLogin()
	check("mismatch", url.Values{"code": {"ct-code-ok"}, "state": {"nope"}}, "invalid_state")
	check("missing", url.Values{"code": {"ct-code-ok"}}, "invalid_state")
	if n := e.sessionCount(); n != 0 {
		t.Errorf("sessions after invalid_state = %d, want 0", n)
	}
	// CT-36: error 파라미터보다 state 검증 우선
	check("error-without-state", url.Values{"error": {"access_denied"}}, "invalid_state")
	// CT-25: state 재사용
	_, state := e.login("ct-code-ok")
	check("reuse", url.Values{"code": {"ct-code-ok"}, "state": {state}}, "invalid_state")
}

func TestCT26_GitHubErrors(t *testing.T) {
	e := ctNewEnv(t)
	_, state := e.startLogin()
	resp, b := e.callback(url.Values{"error": {"access_denied"}, "state": {state}})
	if resp.StatusCode != http.StatusBadRequest || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
		t.Errorf("access_denied: status %d ct %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if !strings.Contains(string(b), "minmo://auth?error=access_denied&state="+state) {
		t.Errorf("access_denied: body lacks deep link with state: %q", string(b))
	}
	// missing_code
	_, state = e.startLogin()
	resp, b = e.callback(url.Values{"state": {state}})
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(b), "missing_code") {
		t.Errorf("missing_code: status %d body %q", resp.StatusCode, string(b))
	}
	// invalid_code (GitHub bad_verification_code)
	_, state = e.startLogin()
	resp, b = e.callback(url.Values{"code": {"ct-code-bad"}, "state": {state}})
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(b), "invalid_code") {
		t.Errorf("invalid_code: status %d body %q", resp.StatusCode, string(b))
	}
	if n := e.sessionCount(); n != 0 {
		t.Errorf("sessions = %d, want 0", n)
	}
}

func TestCT04_CT05_CT06_CT18_Me(t *testing.T) {
	e := ctNewEnv(t)
	// CT-04
	status, m := e.doJSON("GET", "/me", "", nil)
	ctExpectError(t, status, m, 401, "unauthorized", "")
	status, m = e.doJSON("GET", "/me", strings.Repeat("A", 43), nil)
	ctExpectError(t, status, m, 401, "unauthorized", "")
	// CT-05
	token, _ := e.login("ct-code-ok")
	status, m = e.doJSON("GET", "/me", token, nil)
	if status != 200 {
		t.Fatalf("/me status %d %v", status, m)
	}
	ctMatch(t, "me", ctFixture(t, "me.json"), m)
	// avatarUrl null 허용
	token2, _ := e.login("ct-code-user2")
	status, m = e.doJSON("GET", "/me", token2, nil)
	if status != 200 || m["githubLogin"] != "hubot" || m["avatarUrl"] != nil {
		t.Errorf("/me user2: %d %v", status, m)
	}
	// CT-18
	status, m = e.doJSON("GET", "/me/github-token", token, nil)
	if status != 200 || m["accessToken"] != "gho_ct_token" {
		t.Errorf("github-token: %d %v", status, m)
	}
	// CT-06
	status, _ = e.doJSON("DELETE", "/auth/session", token, nil)
	if status != http.StatusNoContent {
		t.Errorf("logout status %d", status)
	}
	status, m = e.doJSON("GET", "/me", token, nil)
	ctExpectError(t, status, m, 401, "unauthorized", "")
}

func TestCT24_SessionExpiry(t *testing.T) {
	e := ctNewEnv(t)
	token, _ := e.login("ct-code-ok")
	e.now = e.now.Add(29 * 24 * time.Hour)
	if status, _ := e.doJSON("GET", "/me", token, nil); status != 200 {
		t.Errorf("29d: status %d, want 200", status)
	}
	e.now = e.now.Add(2 * 24 * time.Hour)
	status, m := e.doJSON("GET", "/me", token, nil)
	ctExpectError(t, status, m, 401, "unauthorized", "")
}

// ---- 공통 (CT-17, 27, 33) ----

func TestCT17_CORS(t *testing.T) {
	e := ctNewEnv(t)
	for _, origin := range ctCORSOrigins {
		resp, _ := e.do("OPTIONS", "/me", "", nil, map[string]string{"Origin": origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"})
		if resp.StatusCode != http.StatusNoContent {
			t.Errorf("%s: preflight status %d", origin, resp.StatusCode)
		}
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != origin {
			t.Errorf("%s: ACAO %q", origin, got)
		}
		if !strings.Contains(strings.ToLower(resp.Header.Get("Vary")), "origin") {
			t.Errorf("%s: Vary %q lacks Origin", origin, resp.Header.Get("Vary"))
		}
		if !strings.Contains(strings.ToLower(resp.Header.Get("Access-Control-Allow-Headers")), "authorization") {
			t.Errorf("%s: Allow-Headers %q", origin, resp.Header.Get("Access-Control-Allow-Headers"))
		}
	}
	resp, _ := e.do("OPTIONS", "/me", "", nil, map[string]string{"Origin": "http://evil.example", "Access-Control-Request-Method": "GET"})
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("evil origin: ACAO %q, want empty", got)
	}
}

func TestCT27_NotFoundMethodNotAllowed(t *testing.T) {
	e := ctNewEnv(t)
	status, m := e.doJSON("GET", "/nope", "", nil)
	ctExpectError(t, status, m, 404, "not_found", "")
	token, _ := e.login("ct-code-ok")
	status, m = e.doJSON("POST", "/me", token, nil)
	ctExpectError(t, status, m, 405, "method_not_allowed", "")
}

func TestCT33_Healthz(t *testing.T) {
	e := ctNewEnv(t)
	status, m := e.doJSON("GET", "/healthz", "", nil)
	if status != 200 || m["status"] != "ok" {
		t.Errorf("healthz %d %v", status, m)
	}
}

// ---- 설정 (CT-07~12, 22, 23, 28, 29, 32) ----

func TestCT07_CT22_SettingsDefaults(t *testing.T) {
	e := ctNewEnv(t)
	token, _ := e.login("ct-code-ok")
	status, m := e.doJSON("GET", "/settings", token, nil)
	if status != 200 {
		t.Fatalf("GET /settings %d %v", status, m)
	}
	ctMatch(t, "global", ctFixture(t, "settings-global-default.json"), m)
	status, m = e.doJSON("GET", "/orgs/acme/settings", token, nil)
	if status != 200 {
		t.Fatalf("GET org %d %v", status, m)
	}
	ctMatch(t, "org", ctFixture(t, "settings-scope-empty.json"), m)
	status, m = e.doJSON("GET", "/projects/acme/widgets/settings", token, nil)
	if status != 200 {
		t.Fatalf("GET project %d %v", status, m)
	}
	ctMatch(t, "project", ctFixture(t, "settings-scope-empty.json"), m)
}

func TestCT08_CT29_GlobalRequiresAllFields(t *testing.T) {
	e := ctNewEnv(t)
	token, _ := e.login("ct-code-ok")
	full := ctFullGlobal(nil)
	delete(full, "worktreePath")
	status, m := e.doJSON("PUT", "/settings", token, full)
	ctExpectError(t, status, m, 400, "global_requires_all_fields", "worktreePath")
	// 검증 순서: 선언 순서의 첫 누락 필드
	status, m = e.doJSON("PUT", "/settings", token, map[string]any{})
	ctExpectError(t, status, m, 400, "global_requires_all_fields", "branchTemplate")
	// CT-29: 명시 null
	status, m = e.doJSON("PUT", "/settings", token, ctFullGlobal(map[string]any{"worktreePath": nil}))
	ctExpectError(t, status, m, 400, "global_requires_all_fields", "worktreePath")
	// 정상 PUT
	status, m = e.doJSON("PUT", "/settings", token, ctFullGlobal(map[string]any{"etcBranchName": "misc"}))
	if status != 200 || m["etcBranchName"] != "misc" {
		t.Errorf("PUT /settings %d %v", status, m)
	}
	ctMatch(t, "updatedAt", "<ts>", m["updatedAt"])
}

func TestCT09_ProjectOverrideEffective(t *testing.T) {
	e := ctNewEnv(t)
	token, _ := e.login("ct-code-ok")
	status, m := e.doJSON("PUT", "/projects/acme/widgets/settings", token, map[string]any{"branchTemplate": "feat/{number}"})
	if status != 200 {
		t.Fatalf("PUT project %d %v", status, m)
	}
	ctMatch(t, "record", map[string]any{"branchTemplate": "feat/{number}", "etcBranchName": nil, "worktreePath": nil, "mainClonePath": nil, "postCreateScript": nil, "sparsePaths": nil, "updatedAt": "<ts>"}, m)
	status, m = e.doJSON("GET", "/projects/acme/widgets/settings/effective", token, nil)
	if status != 200 {
		t.Fatalf("GET effective %d %v", status, m)
	}
	ctMatch(t, "effective", ctFixture(t, "effective-project-override.json"), m)
}

func TestCT10_CT11_CT28_Validation(t *testing.T) {
	e := ctNewEnv(t)
	token, _ := e.login("ct-code-ok")
	// CT-10: {number} 없음 — 전역·org·project
	status, m := e.doJSON("PUT", "/settings", token, ctFullGlobal(map[string]any{"branchTemplate": "feat/x"}))
	ctExpectError(t, status, m, 400, "invalid_template", "branchTemplate")
	status, m = e.doJSON("PUT", "/orgs/acme/settings", token, map[string]any{"branchTemplate": "feat/x"})
	ctExpectError(t, status, m, 400, "invalid_template", "branchTemplate")
	status, m = e.doJSON("PUT", "/projects/acme/widgets/settings", token, map[string]any{"branchTemplate": "feat/x"})
	ctExpectError(t, status, m, 400, "invalid_template", "branchTemplate")
	// CT-11
	status, m = e.doJSON("PUT", "/orgs/acme/settings", token, map[string]any{"worktreePath": "~/w/{owner}/{repo}"})
	ctExpectError(t, status, m, 400, "invalid_path_template", "worktreePath")
	status, m = e.doJSON("PUT", "/orgs/acme/settings", token, map[string]any{"mainClonePath": "~/m/{owner}/{repo}/{branch}"})
	ctExpectError(t, status, m, 400, "invalid_path_template", "mainClonePath")
	// CT-28: etcBranchName ref 규칙, "" 규칙, 스크립트 크기
	status, m = e.doJSON("PUT", "/settings", token, ctFullGlobal(map[string]any{"etcBranchName": "a b"}))
	ctExpectError(t, status, m, 400, "invalid_template", "etcBranchName")
	status, m = e.doJSON("PUT", "/orgs/acme/settings", token, map[string]any{"branchTemplate": ""})
	ctExpectError(t, status, m, 400, "invalid_template", "branchTemplate")
	status, m = e.doJSON("PUT", "/orgs/acme/settings", token, map[string]any{"postCreateScript": ""})
	if status != 200 || m["postCreateScript"] != "" {
		t.Errorf("org postCreateScript \"\": %d %v", status, m)
	}
	status, m = e.doJSON("GET", "/projects/acme/widgets/settings/effective", token, nil)
	if status != 200 {
		t.Fatalf("effective %d", status)
	}
	if src, _ := m["sources"].(map[string]any); src["postCreateScript"] != "org" {
		t.Errorf("postCreateScript source %v, want org", src["postCreateScript"])
	}
	status, m = e.doJSON("PUT", "/orgs/acme/settings", token, map[string]any{"postCreateScript": strings.Repeat("x", 65537)})
	ctExpectError(t, status, m, 400, "script_too_large", "postCreateScript")
	// v2.6 sparsePaths
	status, m = e.doJSON("PUT", "/orgs/acme/settings", token, map[string]any{"sparsePaths": "a/../b"})
	ctExpectError(t, status, m, 400, "invalid_sparse_paths", "sparsePaths")
	status, m = e.doJSON("PUT", "/orgs/acme/settings", token, map[string]any{"postCreateScript": strings.Repeat("x", 65536)})
	if status != 200 {
		t.Errorf("65536B script: %d %v", status, m)
	}
	// 타입 불일치
	status, m = e.doJSON("PUT", "/orgs/acme/settings", token, map[string]any{"branchTemplate": 42})
	ctExpectError(t, status, m, 400, "invalid_json", "branchTemplate")
	// 알 수 없는 키는 무시
	status, m = e.doJSON("PUT", "/orgs/acme/settings", token, map[string]any{"etcBranchName": "misc", "updatedAt": "2020-01-01T00:00:00.000Z", "bogus": 1})
	if status != 200 || m["etcBranchName"] != "misc" {
		t.Errorf("unknown keys: %d %v", status, m)
	}
}

func TestCT12_CT23_OrgInheritance(t *testing.T) {
	e := ctNewEnv(t)
	token, _ := e.login("ct-code-ok")
	status, m := e.doJSON("PUT", "/orgs/acme/settings", token, map[string]any{"worktreePath": "~/work/{owner}/{repo}/{key}"})
	if status != 200 {
		t.Fatalf("PUT org %d %v", status, m)
	}
	effective := func() (map[string]any, map[string]any) {
		t.Helper()
		status, m := e.doJSON("GET", "/projects/acme/widgets/settings/effective", token, nil)
		if status != 200 {
			t.Fatalf("effective %d %v", status, m)
		}
		v, _ := m["values"].(map[string]any)
		s, _ := m["sources"].(map[string]any)
		for _, k := range []string{"branchTemplate", "etcBranchName", "worktreePath", "mainClonePath", "postCreateScript"} {
			if _, ok := s[k]; !ok {
				t.Errorf("sources lacks %s", k)
			}
		}
		return v, s
	}
	v, s := effective()
	if v["worktreePath"] != "~/work/{owner}/{repo}/{key}" || s["worktreePath"] != "org" {
		t.Errorf("org inheritance: %v / %v", v["worktreePath"], s["worktreePath"])
	}
	status, _ = e.doJSON("PUT", "/projects/acme/widgets/settings", token, map[string]any{"worktreePath": "~/p/{key}"})
	if status != 200 {
		t.Fatalf("PUT project %d", status)
	}
	v, s = effective()
	if v["worktreePath"] != "~/p/{key}" || s["worktreePath"] != "project" {
		t.Errorf("project override: %v / %v", v["worktreePath"], s["worktreePath"])
	}
	// CT-23: null 로 되돌리면 상위로 복귀
	status, _ = e.doJSON("PUT", "/projects/acme/widgets/settings", token, map[string]any{"worktreePath": nil})
	if status != 200 {
		t.Fatalf("PUT project null %d", status)
	}
	status, _ = e.doJSON("PUT", "/orgs/acme/settings", token, map[string]any{})
	if status != 200 {
		t.Fatalf("PUT org empty %d", status)
	}
	v, s = effective()
	if s["worktreePath"] != "global" || v["worktreePath"] != "~/minmo-workspaces/{owner}/{repo}/{branch}" {
		t.Errorf("after null: %v / %v", v["worktreePath"], s["worktreePath"])
	}
}

func TestCT32_PathParams(t *testing.T) {
	e := ctNewEnv(t)
	token, _ := e.login("ct-code-ok")
	status, m := e.doJSON("GET", "/orgs/bad%20own/settings", token, nil)
	ctExpectError(t, status, m, 400, "invalid_path_param", "owner")
	status, m = e.doJSON("GET", "/projects/acme/bad%20repo/settings", token, nil)
	ctExpectError(t, status, m, 400, "invalid_path_param", "repo")
	status, m = e.doJSON("GET", "/projects/acme/x.y/issues/1/notes", token, nil)
	if status != 200 {
		t.Errorf("owner/repo with dot: %d %v", status, m)
	}
	// 대소문자 정규화: 같은 행
	status, _ = e.doJSON("PUT", "/orgs/MyOrg/settings", token, map[string]any{"etcBranchName": "misc"})
	if status != 200 {
		t.Fatalf("PUT MyOrg %d", status)
	}
	status, m = e.doJSON("GET", "/orgs/myorg/settings", token, nil)
	if status != 200 || m["etcBranchName"] != "misc" {
		t.Errorf("case-insensitive org: %d %v", status, m)
	}
}

// ---- 메모 (CT-13~16, 19, 20, 30, 31) ----

func TestCT13_CT14_CT15_Notes(t *testing.T) {
	e := ctNewEnv(t)
	token, _ := e.login("ct-code-ok")
	path := "/projects/acme/widgets/issues/42/notes"
	status, m := e.doJSON("GET", path, token, nil)
	if status != 200 {
		t.Fatalf("GET %d %v", status, m)
	}
	ctMatch(t, "empty", ctFixture(t, "notes-empty.json"), m)
	status, m = e.doJSON("PUT", path, token, map[string]any{"body": "x"})
	if status != 200 {
		t.Fatalf("PUT %d %v", status, m)
	}
	ctMatch(t, "saved", ctFixture(t, "notes-saved.json"), m)
	t1, _ := m["updatedAt"].(string)
	status, m = e.doJSON("GET", path, token, nil)
	if status != 200 || m["body"] != "x" || m["updatedAt"] != t1 {
		t.Errorf("GET after PUT: %d %v (t1 %s)", status, m, t1)
	}
	// 다른 기기가 덮어씀
	e.now = e.now.Add(time.Second)
	status, m = e.doJSON("PUT", path, token, map[string]any{"body": "y"})
	if status != 200 {
		t.Fatalf("PUT y %d", status)
	}
	t2, _ := m["updatedAt"].(string)
	// CT-15: stale base → 409 flat
	status, m = e.doJSON("PUT", path, token, map[string]any{"body": "z", "baseUpdatedAt": t1})
	ctExpectError(t, status, m, 409, "conflict", "")
	ctMatch(t, "conflict", ctFixture(t, "notes-conflict.json"), m)
	if m["body"] != "y" || m["updatedAt"] != t2 {
		t.Errorf("conflict current: %v (want y / %s)", m, t2)
	}
	// 정확한 base → 200
	status, m = e.doJSON("PUT", path, token, map[string]any{"body": "z", "baseUpdatedAt": t2})
	if status != 200 || m["body"] != "z" {
		t.Errorf("PUT with current base: %d %v", status, m)
	}
	// 형식 오류
	status, m = e.doJSON("PUT", path, token, map[string]any{"body": "q", "baseUpdatedAt": "2026-11-09T12:00:00Z"})
	ctExpectError(t, status, m, 400, "invalid_base_updated_at", "")
	status, m = e.doJSON("PUT", path, token, map[string]any{})
	ctExpectError(t, status, m, 400, "invalid_json", "body")
	// 기타 이슈 키
	status, m = e.doJSON("GET", "/projects/acme/widgets/issues/etc/notes", token, nil)
	if status != 200 {
		t.Errorf("etc notes %d %v", status, m)
	}
}

func TestCT16_UserIsolation(t *testing.T) {
	e := ctNewEnv(t)
	tokenA, _ := e.login("ct-code-ok")
	tokenB, _ := e.login("ct-code-user2")
	if status, _ := e.doJSON("PUT", "/projects/acme/widgets/issues/42/notes", tokenA, map[string]any{"body": "secret"}); status != 200 {
		t.Fatalf("A PUT notes %d", status)
	}
	if status, _ := e.doJSON("PUT", "/projects/acme/widgets/settings", tokenA, map[string]any{"branchTemplate": "feat/{number}"}); status != 200 {
		t.Fatalf("A PUT settings %d", status)
	}
	status, m := e.doJSON("GET", "/projects/acme/widgets/issues/42/notes", tokenB, nil)
	if status != 200 {
		t.Fatalf("B GET notes %d", status)
	}
	ctMatch(t, "B notes", ctFixture(t, "notes-empty.json"), m)
	status, m = e.doJSON("GET", "/projects/acme/widgets/settings", tokenB, nil)
	if status != 200 {
		t.Fatalf("B GET settings %d", status)
	}
	ctMatch(t, "B settings", ctFixture(t, "settings-scope-empty.json"), m)
}

func TestCT19_IssueKey(t *testing.T) {
	e := ctNewEnv(t)
	token, _ := e.login("ct-code-ok")
	for _, k := range []string{"abc", "0", "-1", "01"} {
		status, m := e.doJSON("GET", "/projects/acme/widgets/issues/"+k+"/notes", token, nil)
		ctExpectError(t, status, m, 400, "invalid_issue_key", "")
	}
	for _, k := range []string{"etc", "42"} {
		if status, m := e.doJSON("GET", "/projects/acme/widgets/issues/"+k+"/notes", token, nil); status != 200 {
			t.Errorf("key %s: %d %v", k, status, m)
		}
	}
}

func TestCT20_BodySize(t *testing.T) {
	e := ctNewEnv(t)
	token, _ := e.login("ct-code-ok")
	path := "/projects/acme/widgets/issues/42/notes"
	status, m := e.doJSON("PUT", path, token, map[string]any{"body": strings.Repeat("a", 1048577)})
	ctExpectError(t, status, m, 400, "body_too_large", "")
	status, m = e.doJSON("PUT", path, token, map[string]any{"body": strings.Repeat("a", 1048576)})
	if status != 200 {
		t.Errorf("1 MiB body: %d %v", status, m)
	}
	// JSON 이스케이프 팽창: 큰따옴표 1 MiB 개 → 요청 JSON 은 2 MiB 이상이지만 본문은 정확히 1 MiB
	status, m = e.doJSON("PUT", path, token, map[string]any{"body": strings.Repeat(`"`, 1048576)})
	if status != 200 {
		t.Errorf("escaped 1 MiB body: %d %v", status, m)
	}
}

func TestCT30_BaseNull(t *testing.T) {
	e := ctNewEnv(t)
	token, _ := e.login("ct-code-ok")
	path := "/projects/acme/widgets/issues/7/notes"
	status, m := e.doJSON("PUT", path, token, map[string]any{"body": "a", "baseUpdatedAt": nil})
	if status != 200 {
		t.Fatalf("first PUT with null base: %d %v", status, m)
	}
	status, m = e.doJSON("PUT", path, token, map[string]any{"body": "b", "baseUpdatedAt": nil})
	ctExpectError(t, status, m, 409, "conflict", "")
	if m["body"] != "a" {
		t.Errorf("conflict current body %v, want a", m["body"])
	}
}

func TestCT31_SameMillisecond(t *testing.T) {
	e := ctNewEnv(t)
	token, _ := e.login("ct-code-ok")
	path := "/projects/acme/widgets/issues/8/notes"
	status, m := e.doJSON("PUT", path, token, map[string]any{"body": "1"})
	if status != 200 {
		t.Fatalf("PUT 1 %d", status)
	}
	t1, _ := m["updatedAt"].(string)
	status, m = e.doJSON("PUT", path, token, map[string]any{"body": "2"}) // now 고정 → 같은 밀리초
	if status != 200 {
		t.Fatalf("PUT 2 %d", status)
	}
	t2, _ := m["updatedAt"].(string)
	if t1 == t2 {
		t.Errorf("updatedAt must advance within the same millisecond: %s", t1)
	}
	if !ctReTS.MatchString(t2) || t2 < t1 {
		t.Errorf("updatedAt order: %s then %s", t1, t2)
	}
	status, m = e.doJSON("PUT", path, token, map[string]any{"body": "3", "baseUpdatedAt": t1})
	ctExpectError(t, status, m, 409, "conflict", "")
}
