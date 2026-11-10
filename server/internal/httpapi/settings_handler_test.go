package httpapi_test

import (
	"regexp"
	"strings"
	"testing"

	"github.com/kangmomin/minmo-cli/server/internal/githubmock"
	"github.com/kangmomin/minmo-cli/server/internal/testutil"
)

var reTS = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

var settingsFields = []string{"branchTemplate", "etcBranchName", "worktreePath", "mainClonePath", "postCreateScript", "sparsePaths"}

// requiredGlobalFields 는 전역 PUT 에서 생략·null 이 400 인 필드(sparsePaths 는 v2.6 호환을 위해 제외)
var requiredGlobalFields = settingsFields[:5]

var defaultGlobal = map[string]any{
	"branchTemplate":   "issue/{number}-{slug}",
	"etcBranchName":    "etc",
	"worktreePath":     "~/minmo-workspaces/{owner}/{repo}/{branch}",
	"mainClonePath":    "~/minmo-workspaces/{owner}/{repo}/_main",
	"postCreateScript": "",
	"sparsePaths":      "",
}

func globalWith(over map[string]any) map[string]any {
	m := map[string]any{}
	for k, v := range defaultGlobal {
		m[k] = v
	}
	for k, v := range over {
		m[k] = v
	}
	return m
}

func expectEmptyScope(t *testing.T, name string, status int, m map[string]any) {
	t.Helper()
	if status != 200 {
		t.Errorf("%s: status %d %v", name, status, m)
		return
	}
	if len(m) != 7 {
		t.Errorf("%s: want 7 keys, got %v", name, m)
	}
	for _, k := range append(append([]string{}, settingsFields...), "updatedAt") {
		if v, ok := m[k]; !ok || v != nil {
			t.Errorf("%s: %s = %v (present %v), want null", name, k, v, ok)
		}
	}
}

// CT-07: 신규 사용자 E6 → 6필드 기본값 정확히 + updatedAt(ms 포맷), 키는 정확히 7개
func TestSettings_GlobalDefaults_CT07(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	status, m := s.DoJSON("GET", "/settings", token, nil)
	if status != 200 || len(m) != 7 {
		t.Fatalf("GET /settings %d %v", status, m)
	}
	for k, v := range defaultGlobal {
		if m[k] != v {
			t.Errorf("%s = %v, want %v", k, m[k], v)
		}
	}
	if ts, _ := m["updatedAt"].(string); !reTS.MatchString(ts) {
		t.Errorf("updatedAt %v", m["updatedAt"])
	}
}

// CT-08 / EC-22: E7 각 필드 누락 → global_requires_all_fields field=그 필드 / 선언 순서상 첫 누락
func TestSettings_GlobalMissingField_CT08(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	for _, f := range requiredGlobalFields {
		body := globalWith(nil)
		delete(body, f)
		status, m := s.DoJSON("PUT", "/settings", token, body)
		expectErr(t, status, m, 400, "global_requires_all_fields", f)
	}
	body := globalWith(nil)
	delete(body, "mainClonePath")
	delete(body, "etcBranchName")
	status, m := s.DoJSON("PUT", "/settings", token, body)
	expectErr(t, status, m, 400, "global_requires_all_fields", "etcBranchName")
	// 실패한 PUT 은 저장값을 바꾸지 않는다
	status, m = s.DoJSON("GET", "/settings", token, nil)
	if status != 200 || m["etcBranchName"] != "etc" {
		t.Errorf("after failed PUT: %d %v", status, m)
	}
}

// CT-29 / EC-22: E7 명시 null → global_requires_all_fields (각 필드)
func TestSettings_GlobalExplicitNull_CT29(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	for _, f := range requiredGlobalFields {
		status, m := s.DoJSON("PUT", "/settings", token, globalWith(map[string]any{f: nil}))
		expectErr(t, status, m, 400, "global_requires_all_fields", f)
	}
	// v2.6: sparsePaths 는 전역에서도 생략·null 허용 → 저장된 값 유지(처음엔 "")
	for _, body := range []map[string]any{globalWith(map[string]any{"sparsePaths": nil}), func() map[string]any { b := globalWith(nil); delete(b, "sparsePaths"); return b }()} {
		status, m := s.DoJSON("PUT", "/settings", token, body)
		if status != 200 || m["sparsePaths"] != "" {
			t.Errorf("global sparsePaths omitted/null: %d %v", status, m)
		}
	}
	// 저장된 값이 있으면 생략한 PUT(이전 클라이언트)이 지우지 않는다
	if status, m := s.DoJSON("PUT", "/settings", token, globalWith(map[string]any{"sparsePaths": "desktop"})); status != 200 || m["sparsePaths"] != "desktop" {
		t.Fatalf("PUT sparsePaths: %d %v", status, m)
	}
	body := globalWith(map[string]any{"etcBranchName": "misc"})
	delete(body, "sparsePaths")
	if status, m := s.DoJSON("PUT", "/settings", token, body); status != 200 || m["sparsePaths"] != "desktop" || m["etcBranchName"] != "misc" {
		t.Errorf("omitted sparsePaths should keep stored value: %d %v", status, m)
	}
	s.DoJSON("PUT", "/settings", token, globalWith(nil))
	// 전역은 postCreateScript "" 허용 — 저장 후 그대로 반환
	status, m := s.DoJSON("PUT", "/settings", token, globalWith(map[string]any{"postCreateScript": "", "branchTemplate": "feat/{number}"}))
	if status != 200 || m["postCreateScript"] != "" || m["branchTemplate"] != "feat/{number}" {
		t.Errorf("valid global PUT %d %v", status, m)
	}
}

// CT-22: 행 없는 E8/E10 → 200, 5필드 null · updatedAt null
func TestSettings_EmptyScopes_CT22(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	status, m := s.DoJSON("GET", "/orgs/acme/settings", token, nil)
	expectEmptyScope(t, "org", status, m)
	status, m = s.DoJSON("GET", "/projects/acme/widgets/settings", token, nil)
	expectEmptyScope(t, "project", status, m)
	// org 만 저장해도 project 행은 여전히 비어 있다(상속은 effective 에서만)
	if status, _ := s.DoJSON("PUT", "/orgs/acme/settings", token, map[string]any{"etcBranchName": "misc"}); status != 200 {
		t.Fatalf("PUT org %d", status)
	}
	status, m = s.DoJSON("GET", "/projects/acme/widgets/settings", token, nil)
	expectEmptyScope(t, "project after org", status, m)
	// 저장 행은 null 을 그대로 유지한다
	status, m = s.DoJSON("GET", "/orgs/acme/settings", token, nil)
	ts, _ := m["updatedAt"].(string)
	if status != 200 || m["etcBranchName"] != "misc" || m["branchTemplate"] != nil || !reTS.MatchString(ts) {
		t.Errorf("org row %d %v", status, m)
	}
}

// CT-16 / EC-05: 사용자 B 는 A 의 settings(전역·org·project)·notes·effective 를 볼 수 없다(자기 레코드 200)
func TestSettings_UserIsolation_CT16(t *testing.T) {
	s := testutil.NewTestServer(t)
	a, _ := s.Login(githubmock.CodeOK)
	b, _ := s.Login(githubmock.CodeUser2)
	mustOK := func(method, path string, body any) {
		t.Helper()
		if status, m := s.DoJSON(method, path, a, body); status != 200 {
			t.Fatalf("A %s %s: %d %v", method, path, status, m)
		}
	}
	mustOK("PUT", "/settings", globalWith(map[string]any{"etcBranchName": "a-etc"}))
	mustOK("PUT", "/orgs/acme/settings", map[string]any{"worktreePath": "~/a/{key}"})
	mustOK("PUT", "/projects/acme/widgets/settings", map[string]any{"branchTemplate": "a/{number}"})
	mustOK("PUT", "/projects/acme/widgets/issues/42/notes", map[string]any{"body": "secret"})

	status, m := s.DoJSON("GET", "/settings", b, nil)
	if status != 200 || m["etcBranchName"] != "etc" {
		t.Errorf("B global %d %v", status, m)
	}
	status, m = s.DoJSON("GET", "/orgs/acme/settings", b, nil)
	expectEmptyScope(t, "B org", status, m)
	status, m = s.DoJSON("GET", "/projects/acme/widgets/settings", b, nil)
	expectEmptyScope(t, "B project", status, m)
	status, m = s.DoJSON("GET", "/projects/acme/widgets/settings/effective", b, nil)
	if v, _ := m["values"].(map[string]any); status != 200 || v["branchTemplate"] != "issue/{number}-{slug}" || v["worktreePath"] != defaultGlobal["worktreePath"] {
		t.Errorf("B effective %d %v", status, m)
	}
	status, m = s.DoJSON("GET", "/projects/acme/widgets/issues/42/notes", b, nil)
	if status != 200 || m["body"] != "" || m["updatedAt"] != nil {
		t.Errorf("B notes %d %v", status, m)
	}
	// B 의 쓰기는 A 에 영향 없음
	if status, _ := s.DoJSON("PUT", "/projects/acme/widgets/issues/42/notes", b, map[string]any{"body": "mine", "baseUpdatedAt": nil}); status != 200 {
		t.Errorf("B PUT notes (no row for B) %d", status)
	}
	status, m = s.DoJSON("GET", "/projects/acme/widgets/issues/42/notes", a, nil)
	if status != 200 || m["body"] != "secret" {
		t.Errorf("A notes after B write %d %v", status, m)
	}
}

// CT-32: owner/repo path param 검증(field 지정) · 검증 순서(401 → owner → repo → JSON) · 소문자 정규화
func TestSettings_PathParams_CT32(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	long := strings.Repeat("a", 101)
	for _, c := range []struct{ path, field string }{
		{"/orgs/bad%2Fown/settings", "owner"},
		{"/orgs/bad%20own/settings", "owner"},
		{"/orgs/" + long + "/settings", "owner"},
		{"/orgs/bad%24/settings", "owner"},
		{"/projects/bad%2Fown/widgets/settings", "owner"},
		{"/projects/acme/bad%20repo/settings", "repo"},
		{"/projects/acme/" + long + "/settings/effective", "repo"},
		{"/projects/bad%20own/bad%20repo/settings", "owner"},
	} {
		status, m := s.DoJSON("GET", c.path, token, nil)
		expectErr(t, status, m, 400, "invalid_path_param", c.field)
	}
	for _, p := range []string{"/orgs/" + strings.Repeat("a", 100) + "/settings", "/orgs/my_org.x-y/settings", "/projects/a.b/c_d-e/settings"} {
		if status, m := s.DoJSON("GET", p, token, nil); status != 200 {
			t.Errorf("valid path %s: %d %v", p, status, m)
		}
	}
	// ① 401 이 path 검증보다 먼저
	status, m := s.DoJSON("GET", "/orgs/bad%20own/settings", "", nil)
	expectErr(t, status, m, 401, "unauthorized", "")
	// ② path 검증이 JSON 디코드보다 먼저
	resp, b := s.Do("PUT", "/orgs/bad%20own/settings", token, "{not json", nil)
	if resp.StatusCode != 400 || !strings.Contains(string(b), `"invalid_path_param"`) {
		t.Errorf("path before JSON: %d %s", resp.StatusCode, b)
	}
	// 소문자 정규화: 대소문자만 다른 owner/repo 는 같은 행
	if status, _ := s.DoJSON("PUT", "/projects/MyOrg/Repo-A/settings", token, map[string]any{"branchTemplate": "feat/{number}"}); status != 200 {
		t.Fatalf("PUT MyOrg/Repo-A %d", status)
	}
	status, m = s.DoJSON("GET", "/projects/myorg/repo-a/settings", token, nil)
	if status != 200 || m["branchTemplate"] != "feat/{number}" {
		t.Errorf("lowercase GET %d %v", status, m)
	}
	if status, _ := s.DoJSON("PUT", "/orgs/MYORG/settings", token, map[string]any{"etcBranchName": "misc"}); status != 200 {
		t.Fatalf("PUT MYORG %d", status)
	}
	status, m = s.DoJSON("GET", "/projects/MyOrg/REPO-A/settings/effective", token, nil)
	src, _ := m["sources"].(map[string]any)
	if status != 200 || src["etcBranchName"] != "org" || src["branchTemplate"] != "project" {
		t.Errorf("effective across casing %d %v", status, m)
	}
}

// Surface MaxBytes: settings PUT 본문은 1 MiB 초과 시 413 payload_too_large (전역·org)
func TestSettings_PayloadTooLarge(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	const limit = 1 << 20
	prefix, suffix := `{"etcBranchName":"`, `"}`
	// 전체 요청 바이트가 정확히 limit+1 이 되도록 문자열 값을 채운다
	body := prefix + strings.Repeat("a", limit+1-len(prefix)-len(suffix)) + suffix
	if len(body) != limit+1 {
		t.Fatalf("body len %d", len(body))
	}
	for _, path := range []string{"/settings", "/orgs/acme/settings"} {
		status, m := s.DoJSON("PUT", path, token, body)
		expectErr(t, status, m, 413, "payload_too_large", "")
	}
}
