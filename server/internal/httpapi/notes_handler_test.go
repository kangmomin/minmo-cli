package httpapi_test

import (
	"strings"
	"testing"

	"github.com/kangmomin/minmo-cli/server/internal/githubmock"
	"github.com/kangmomin/minmo-cli/server/internal/testutil"
)

const notesBase = "/projects/acme/widgets/issues/"

// CT-19: key `^(etc|[1-9][0-9]{0,9})$` — 위반은 GET·PUT 모두 400 invalid_issue_key(field 없음)
func TestNotes_IssueKey_CT19(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	for _, k := range []string{"abc", "0", "-1", "01", "ETC", "Etc", "12345678901", "1.5", "etc1", "%20"} {
		status, m := s.DoJSON("GET", notesBase+k+"/notes", token, nil)
		expectErr(t, status, m, 400, "invalid_issue_key", "")
		status, m = s.DoJSON("PUT", notesBase+k+"/notes", token, map[string]any{"body": "x"})
		expectErr(t, status, m, 400, "invalid_issue_key", "")
	}
	for _, k := range []string{"etc", "42", "1", "1234567890"} {
		if status, m := s.DoJSON("GET", notesBase+k+"/notes", token, nil); status != 200 {
			t.Errorf("GET key %s: %d %v", k, status, m)
		}
		if status, m := s.DoJSON("PUT", notesBase+k+"/notes", token, map[string]any{"body": "k" + k}); status != 200 || m["body"] != "k"+k {
			t.Errorf("PUT key %s: %d %v", k, status, m)
		}
	}
	// 검증 순서: owner → repo → key, 그리고 key 검증이 JSON 디코드보다 먼저
	status, m := s.DoJSON("GET", "/projects/bad%20own/widgets/issues/abc/notes", token, nil)
	expectErr(t, status, m, 400, "invalid_path_param", "owner")
	status, m = s.DoJSON("GET", "/projects/acme/bad%20repo/issues/abc/notes", token, nil)
	expectErr(t, status, m, 400, "invalid_path_param", "repo")
	resp, b := s.Do("PUT", notesBase+"abc/notes", token, "{not json", nil)
	if resp.StatusCode != 400 || !strings.Contains(string(b), `"invalid_issue_key"`) {
		t.Errorf("key before JSON: %d %s", resp.StatusCode, b)
	}
	// 401 이 key 검증보다 먼저
	status, m = s.DoJSON("GET", notesBase+"abc/notes", "", nil)
	expectErr(t, status, m, 401, "unauthorized", "")
}

// CT-20: 디코딩 후 UTF-8 바이트 기준 1,048,576 상한 · JSON 팽창은 8 MiB 까지 수용 · 초과 요청은 413
func TestNotes_BodySize_CT20(t *testing.T) {
	s := testutil.NewTestServer(t)
	token, _ := s.Login(githubmock.CodeOK)
	path := notesBase + "42/notes"
	put := func(body string) (int, map[string]any) {
		t.Helper()
		return s.DoJSON("PUT", path, token, map[string]any{"body": body})
	}
	status, m := put(strings.Repeat("a", 1048577))
	expectErr(t, status, m, 400, "body_too_large", "")
	if status, m := put(strings.Repeat("a", 1048576)); status != 200 {
		t.Errorf("1 MiB ascii: %d %v", status, m)
	}
	// 멀티바이트: rune 수가 아니라 바이트 수로 판정
	status, m = put(strings.Repeat("가", 349526)) // 1,048,578 bytes
	expectErr(t, status, m, 400, "body_too_large", "")
	status, m = put(strings.Repeat("가", 349525)) // 1,048,575 bytes
	if got, _ := m["body"].(string); status != 200 || len(got) != 1048575 {
		t.Errorf("multibyte under limit: %d", status)
	}
	// JSON 이스케이프 팽창: 요청 JSON 2 MiB 이상이어도 본문은 정확히 1 MiB → 200
	if status, m := put(strings.Repeat(`"`, 1048576)); status != 200 {
		t.Errorf("escaped quotes: %d %v", status, m)
	}
	if status, m := put(strings.Repeat("\x01", 1048576)); status != 200 { // \u0001 → 요청 6 MiB
		t.Errorf("escaped control chars: %d %v", status, m)
	}
	// 8 MiB 를 넘는 요청 → 413 payload_too_large
	status, m = put(strings.Repeat("\x01", 1500000)) // \u0001 × 1.5M ≈ 9 MB
	expectErr(t, status, m, 413, "payload_too_large", "")
	// 거부된 PUT 은 저장값을 바꾸지 않는다
	status, m = s.DoJSON("GET", path, token, nil)
	if status != 200 || m["body"] != strings.Repeat("\x01", 1048576) {
		t.Errorf("stored body changed by rejected PUT (status %d)", status)
	}
}
