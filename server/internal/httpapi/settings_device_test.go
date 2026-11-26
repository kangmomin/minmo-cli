package httpapi_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/kangmomin/minmo-cli/server/internal/githubmock"
	"github.com/kangmomin/minmo-cli/server/internal/testutil"
)

const (
	pcA = "11111111-1111-4111-8111-111111111111"
	pcB = "22222222-2222-4222-8222-222222222222"
)

// doPC 는 X-Minmo-Pc 헤더를 붙여 요청한다(pc 가 "" 면 헤더 없음 — 함께 쓰는 값).
func doPC(t *testing.T, s *testutil.Server, method, path, token, pc string, body any) (int, map[string]any) {
	t.Helper()
	var hdr map[string]string
	if pc != "" {
		hdr = map[string]string{"X-Minmo-Pc": pc}
	}
	resp, b := s.Do(method, path, token, body, hdr)
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("%s %s: status %d non-JSON body %q", method, path, resp.StatusCode, b)
	}
	return resp.StatusCode, m
}

// PC 별 행이 없으면 함께 쓰는 값이 그대로 보인다 — 처음 나눌 때 지금 값에서 시작한다
func TestDeviceSettings_FallsBackToSharedUntilSaved(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	if status, m := s.DoJSON("PUT", "/settings", token, globalWith(map[string]any{"worktreePath": "~/shared/{branch}"})); status != 200 {
		t.Fatalf("shared PUT %d %v", status, m)
	}
	status, m := doPC(t, s, "GET", "/settings", token, pcA, nil)
	if status != 200 || m["worktreePath"] != "~/shared/{branch}" {
		t.Errorf("PC GET before save %d %v", status, m)
	}
	status, m = doPC(t, s, "GET", "/projects/acme/widgets/settings/effective", token, pcA, nil)
	if v, _ := m["values"].(map[string]any); status != 200 || v["worktreePath"] != "~/shared/{branch}" {
		t.Errorf("PC effective before save %d %v", status, m)
	}
}

// PC 별로 저장하면 경로·스크립트는 그 PC 에만, 이름을 정하는 값은 모든 PC 에 적용된다
func TestDeviceSettings_SplitsLocalFieldsFromSharedOnes(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	if status, m := s.DoJSON("PUT", "/settings", token, globalWith(map[string]any{"worktreePath": "~/shared/{branch}", "postCreateScript": "shared.ps1"})); status != 200 {
		t.Fatalf("shared PUT %d %v", status, m)
	}

	status, m := doPC(t, s, "PUT", "/settings", token, pcA, globalWith(map[string]any{
		"branchTemplate":   "task/{number}",
		"worktreePath":     "D:/work/{branch}",
		"mainClonePath":    "D:/work/{repo}/_main",
		"postCreateScript": "pc-a.ps1",
	}))
	if status != 200 || m["worktreePath"] != "D:/work/{branch}" || m["branchTemplate"] != "task/{number}" || m["postCreateScript"] != "pc-a.ps1" {
		t.Fatalf("PC A PUT %d %v", status, m)
	}

	// 같은 PC: 저장한 값
	status, m = doPC(t, s, "GET", "/settings", token, pcA, nil)
	if status != 200 || m["worktreePath"] != "D:/work/{branch}" || m["mainClonePath"] != "D:/work/{repo}/_main" {
		t.Errorf("PC A GET %d %v", status, m)
	}
	// 나누지 않은 클라이언트(헤더 없음)와 다른 PC: 경로·스크립트는 그대로, 브랜치 이름 틀은 바뀐다
	for name, pc := range map[string]string{"shared": "", "PC B": pcB} {
		status, m = doPC(t, s, "GET", "/settings", token, pc, nil)
		if status != 200 || m["worktreePath"] != "~/shared/{branch}" || m["postCreateScript"] != "shared.ps1" || m["branchTemplate"] != "task/{number}" {
			t.Errorf("%s GET %d %v", name, status, m)
		}
	}
	// 헤더 없이 저장해도 PC A 의 경로는 남는다
	if status, m := s.DoJSON("PUT", "/settings", token, globalWith(map[string]any{"worktreePath": "~/shared2/{branch}", "branchTemplate": "x/{number}"})); status != 200 {
		t.Fatalf("shared PUT 2 %d %v", status, m)
	}
	status, m = doPC(t, s, "GET", "/settings", token, pcA, nil)
	if status != 200 || m["worktreePath"] != "D:/work/{branch}" || m["branchTemplate"] != "x/{number}" {
		t.Errorf("PC A GET after shared save %d %v", status, m)
	}
}

// org·project 단계도 PC 별로 덮어쓰고, effective 는 단계마다 그 PC 의 값을 먼저 쓴다
func TestDeviceSettings_EffectiveMergesPerPCOverrides(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	must := func(pc, path string, body any) {
		t.Helper()
		if status, m := doPC(t, s, "PUT", path, token, pc, body); status != 200 {
			t.Fatalf("PUT %s (pc %q): %d %v", path, pc, status, m)
		}
	}
	must("", "/orgs/acme/settings", map[string]any{"worktreePath": "~/org/{branch}", "etcBranchName": "misc"})
	// 함께 쓰는 project 행이 없는 상태에서 PC 별로 먼저 저장한다
	must(pcA, "/projects/acme/widgets/settings", map[string]any{"worktreePath": "E:/w/{branch}", "branchTemplate": "w/{number}"})

	effective := func(pc string) (map[string]any, map[string]any) {
		t.Helper()
		status, m := doPC(t, s, "GET", "/projects/acme/widgets/settings/effective", token, pc, nil)
		if status != 200 {
			t.Fatalf("effective (pc %q): %d %v", pc, status, m)
		}
		v, _ := m["values"].(map[string]any)
		src, _ := m["sources"].(map[string]any)
		return v, src
	}
	v, src := effective(pcA)
	if v["worktreePath"] != "E:/w/{branch}" || src["worktreePath"] != "project" || v["branchTemplate"] != "w/{number}" || v["etcBranchName"] != "misc" {
		t.Errorf("PC A effective %v %v", v, src)
	}
	// 다른 PC 는 org 의 경로를 쓰고, 함께 쓰는 브랜치 이름 틀은 받는다
	v, src = effective(pcB)
	if v["worktreePath"] != "~/org/{branch}" || src["worktreePath"] != "org" || v["branchTemplate"] != "w/{number}" {
		t.Errorf("PC B effective %v %v", v, src)
	}
	// PC A 가 project 의 경로를 비우면(null) 그 PC 는 org 값을 상속한다
	must(pcA, "/projects/acme/widgets/settings", map[string]any{"branchTemplate": "w/{number}"})
	if v, src = effective(pcA); v["worktreePath"] != "~/org/{branch}" || src["worktreePath"] != "org" {
		t.Errorf("PC A effective after clearing %v %v", v, src)
	}
}

// 다른 사용자가 같은 PC 식별자를 보내도 서로의 값을 볼 수 없다
func TestDeviceSettings_UserIsolation(t *testing.T) {
	s := testutil.NewTestServer(t)
	a, _ := s.Login(githubmock.CodeOK)
	b, _ := s.Login(githubmock.CodeUser2)
	if status, m := doPC(t, s, "PUT", "/settings", a, pcA, globalWith(map[string]any{"worktreePath": "~/a-only/{branch}"})); status != 200 {
		t.Fatalf("A PUT %d %v", status, m)
	}
	status, m := doPC(t, s, "GET", "/settings", b, pcA, nil)
	if status != 200 || m["worktreePath"] != defaultGlobal["worktreePath"] {
		t.Errorf("B GET with A's PC id %d %v", status, m)
	}
}

// 형식이 틀린 PC 식별자는 400 — 함께 쓰는 값으로 조용히 넘어가 다른 PC 의 설정을 바꾸지 않게
func TestDeviceSettings_RejectsMalformedHeader(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	for _, bad := range []string{"pc-a", "11111111-1111-4111-8111-11111111111", "11111111-1111-4111-8111-11111111111G", "' OR 1=1 --"} {
		for _, req := range []struct{ method, path string }{
			{"GET", "/settings"},
			{"PUT", "/settings"},
			{"GET", "/projects/acme/widgets/settings/effective"},
		} {
			var body any
			if req.method == "PUT" {
				body = globalWith(nil)
			}
			status, m := doPC(t, s, req.method, req.path, token, bad, body)
			if status != http.StatusBadRequest || m["error"] != "invalid_path_param" || m["field"] != "pc" {
				t.Errorf("%s %s with %q: %d %v", req.method, req.path, bad, status, m)
			}
		}
	}
	// 전역 필수 필드 검증은 PC 별 저장에도 그대로 적용된다
	in := globalWith(nil)
	delete(in, "worktreePath")
	if status, m := doPC(t, s, "PUT", "/settings", token, pcA, in); status != http.StatusBadRequest || m["error"] != "global_requires_all_fields" {
		t.Errorf("PC PUT without worktreePath: %d %v", status, m)
	}
}

// 브라우저(Tauri webview)가 X-Minmo-Pc 를 보낼 수 있게 preflight 가 허용한다
func TestDeviceSettings_PreflightAllowsHeader(t *testing.T) {
	s := testutil.NewTestServer(t)
	resp, _ := s.Do("OPTIONS", "/settings", "", nil, map[string]string{
		"Origin":                         "tauri://localhost",
		"Access-Control-Request-Method":  "PUT",
		"Access-Control-Request-Headers": "authorization,content-type,x-minmo-pc",
	})
	if got := resp.Header.Get("Access-Control-Allow-Headers"); got != "Authorization, Content-Type, X-Minmo-Pc" {
		t.Errorf("Access-Control-Allow-Headers = %q", got)
	}
}
