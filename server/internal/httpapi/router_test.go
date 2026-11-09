package httpapi_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/kangmomin/minmo-cli/server/internal/githubmock"
	"github.com/kangmomin/minmo-cli/server/internal/testutil"
)

// expectErr 는 계약 공통 에러 body `{error, field?}` 를 단언한다. field "" 이면 field 키가 없어야 한다.
func expectErr(t *testing.T, status int, m map[string]any, wantStatus int, code, field string) {
	t.Helper()
	if status != wantStatus {
		t.Errorf("status %d, want %d (body %v)", status, wantStatus, m)
	}
	if m["error"] != code {
		t.Errorf("error %v, want %q", m["error"], code)
	}
	if field == "" {
		if f, ok := m["field"]; ok {
			t.Errorf("unexpected field %v", f)
		}
	} else if m["field"] != field {
		t.Errorf("field %v, want %q", m["field"], field)
	}
}

var defaultOrigins = []string{"http://localhost:1420", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"}

// CT-17: 인증 경로 포함 여러 경로의 preflight → 204 + echo + Vary + Allow-Headers/Methods (무인증)
func TestRouter_CORSPreflight_CT17(t *testing.T) {
	s := testutil.NewTestServer(t)
	paths := []string{"/me", "/settings", "/projects/acme/widgets/settings/effective", "/projects/acme/widgets/issues/42/notes", "/auth/session"}
	for _, origin := range defaultOrigins {
		for _, p := range paths {
			resp, _ := s.Do("OPTIONS", p, "", nil, map[string]string{
				"Origin": origin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization, content-type",
			})
			if resp.StatusCode != http.StatusNoContent {
				t.Errorf("%s %s: status %d, want 204", origin, p, resp.StatusCode)
			}
			if got := resp.Header.Get("Access-Control-Allow-Origin"); got != origin {
				t.Errorf("%s %s: ACAO %q", origin, p, got)
			}
			if !strings.Contains(strings.ToLower(resp.Header.Get("Vary")), "origin") {
				t.Errorf("%s %s: Vary %q", origin, p, resp.Header.Get("Vary"))
			}
			h := strings.ToLower(resp.Header.Get("Access-Control-Allow-Headers"))
			if !strings.Contains(h, "authorization") || !strings.Contains(h, "content-type") {
				t.Errorf("%s %s: Allow-Headers %q", origin, p, h)
			}
			m := strings.ToUpper(resp.Header.Get("Access-Control-Allow-Methods"))
			for _, want := range []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"} {
				if !strings.Contains(m, want) {
					t.Errorf("%s %s: Allow-Methods %q lacks %s", origin, p, m, want)
				}
			}
		}
	}
}

// CT-17: 실제 요청에도 허용 Origin echo + Vary, 미허용 Origin 은 헤더 없이 요청 자체는 처리
func TestRouter_CORSActualRequest_CT17(t *testing.T) {
	s := testutil.NewTestServer(t)
	resp, _ := s.Do("GET", "/healthz", "", nil, map[string]string{"Origin": "tauri://localhost"})
	if resp.StatusCode != 200 || resp.Header.Get("Access-Control-Allow-Origin") != "tauri://localhost" {
		t.Errorf("allowed origin GET: %d ACAO %q", resp.StatusCode, resp.Header.Get("Access-Control-Allow-Origin"))
	}
	if !strings.Contains(strings.ToLower(resp.Header.Get("Vary")), "origin") {
		t.Errorf("Vary %q", resp.Header.Get("Vary"))
	}
	resp, _ = s.Do("GET", "/healthz", "", nil, map[string]string{"Origin": "http://evil.example"})
	if resp.StatusCode != 200 {
		t.Errorf("disallowed origin must still be processed: %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed origin ACAO %q, want empty", got)
	}
	// 미허용 Origin 의 인증 요청도 처리(401 JSON) — CORS 는 차단 수단이 아님
	resp, _ = s.Do("GET", "/me", "", nil, map[string]string{"Origin": "http://evil.example"})
	if resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("disallowed origin /me: %d ACAO %q", resp.StatusCode, resp.Header.Get("Access-Control-Allow-Origin"))
	}
}

// CT-27: 미등록 경로 404, 미허용 메서드 405 — 모두 JSON
func TestRouter_NotFoundMethodNotAllowed_CT27(t *testing.T) {
	s := testutil.NewTestServer(t)
	for _, p := range []string{"/nope", "/projects/acme", "/orgs/acme/settings/extra"} {
		status, m := s.DoJSON("GET", p, "", nil)
		expectErr(t, status, m, 404, "not_found", "")
	}
	token, _ := s.Login(githubmock.CodeOK)
	for _, c := range []struct{ method, path string }{
		{"POST", "/me"},
		{"DELETE", "/healthz"},
		{"PUT", "/me/github-token"},
		{"GET", "/auth/session"},
		{"DELETE", "/projects/acme/widgets/settings/effective"},
		{"POST", "/projects/acme/widgets/issues/42/notes"},
	} {
		status, m := s.DoJSON(c.method, c.path, token, nil)
		expectErr(t, status, m, 405, "method_not_allowed", "")
	}
}

// CT-33: healthz 는 무인증 200 {status:"ok"}, 잘못된 토큰이 있어도 200
func TestRouter_Healthz_CT33(t *testing.T) {
	s := testutil.NewTestServer(t)
	status, m := s.DoJSON("GET", "/healthz", "", nil)
	if status != 200 || m["status"] != "ok" || len(m) != 1 {
		t.Errorf("healthz %d %v", status, m)
	}
	status, m = s.DoJSON("GET", "/healthz", "forged-token", nil)
	if status != 200 || m["status"] != "ok" {
		t.Errorf("healthz with bad token %d %v", status, m)
	}
}
