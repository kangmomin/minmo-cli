package settings

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

const templateVectorsPath = "../../../contracts/fixtures/template-vectors.json"

func sp(s string) *string { return &s }

type templateVectors struct {
	RefCases []struct {
		Ref   string `json:"ref"`
		Valid bool   `json:"valid"`
	} `json:"refCases"`
	BranchCases []struct {
		Template string `json:"template"`
		Expected string `json:"expected"`
	} `json:"branchCases"`
}

func loadVectors(t *testing.T) templateVectors {
	t.Helper()
	b, err := os.ReadFile(templateVectorsPath)
	if err != nil {
		t.Fatalf("read %s: %v", templateVectorsPath, err)
	}
	var v templateVectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("decode vectors: %v", err)
	}
	if len(v.RefCases) == 0 || len(v.BranchCases) == 0 {
		t.Fatalf("vectors empty: ref=%d branch=%d", len(v.RefCases), len(v.BranchCases))
	}
	return v
}

// CT-10·CT-28(git ref 규칙표): template-vectors.json refCases 를 isValidRef 로 단언
func TestIsValidRef_Vectors_CT10_CT28(t *testing.T) {
	for _, c := range loadVectors(t).RefCases {
		if got := isValidRef(c.Ref); got != c.Valid {
			t.Errorf("isValidRef(%q) = %v, want %v", c.Ref, got, c.Valid)
		}
	}
}

// CT-10: branchCases[].expected 는 모두 유효 ref, template 은 모두 유효 branchTemplate
func TestBranchCases_Vectors_CT10(t *testing.T) {
	for _, c := range loadVectors(t).BranchCases {
		if !isValidRef(c.Expected) {
			t.Errorf("branchCases expected %q must be a valid ref", c.Expected)
		}
		if code, field := ValidateInput(ScopeProject, Input{BranchTemplate: sp(c.Template)}); code != "" {
			t.Errorf("template %q rejected: %s/%s", c.Template, code, field)
		}
	}
}

type vcase struct {
	name  string
	in    Input
	code  string
	field string
}

func runValidate(t *testing.T, scopes []Scope, cases []vcase) {
	t.Helper()
	for _, sc := range scopes {
		for _, c := range cases {
			in := c.in
			if sc == ScopeGlobal {
				in = fillGlobal(in)
			}
			code, field := ValidateInput(sc, in)
			if code != c.code || field != c.field {
				t.Errorf("[%s] %s: got (%q,%q), want (%q,%q)", sc, c.name, code, field, c.code, c.field)
			}
		}
	}
}

// fillGlobal 은 nil 필드를 유효한 기본 값으로 채워 전역 검증에서 해당 필드만 판정되게 한다.
func fillGlobal(in Input) Input {
	def := map[string]string{
		"branchTemplate": "issue/{number}-{slug}", "etcBranchName": "etc",
		"worktreePath": "~/minmo-workspaces/{owner}/{repo}/{branch}", "mainClonePath": "~/minmo-workspaces/{owner}/{repo}/_main",
		"postCreateScript": "", "sparsePaths": "",
	}
	if in.BranchTemplate == nil {
		in.BranchTemplate = sp(def["branchTemplate"])
	}
	if in.EtcBranchName == nil {
		in.EtcBranchName = sp(def["etcBranchName"])
	}
	if in.WorktreePath == nil {
		in.WorktreePath = sp(def["worktreePath"])
	}
	if in.MainClonePath == nil {
		in.MainClonePath = sp(def["mainClonePath"])
	}
	if in.PostCreateScript == nil {
		in.PostCreateScript = sp(def["postCreateScript"])
	}
	if in.SparsePaths == nil {
		in.SparsePaths = sp(def["sparsePaths"])
	}
	return in
}

var allScopes = []Scope{ScopeGlobal, ScopeOrg, ScopeProject}

// CT-10 / EC-06: branchTemplate 규칙 ({number} 필수 · 허용 토큰 · 닫히지 않은 { · 샘플 치환 후 ref 규칙 · ≤100 rune · "" 금지)
func TestValidate_BranchTemplate_CT10(t *testing.T) {
	ok := func(name, v string) vcase { return vcase{name: name, in: Input{BranchTemplate: sp(v)}} }
	bad := func(name, v string) vcase {
		return vcase{name: name, in: Input{BranchTemplate: sp(v)}, code: "invalid_template", field: "branchTemplate"}
	}
	runValidate(t, allScopes, []vcase{
		ok("default", "issue/{number}-{slug}"),
		ok("number only", "{number}"),
		ok("feat number", "feat/{number}"),
		ok("title token", "{number}-{title}"),
		ok("100 runes", "{number}"+strings.Repeat("a", 92)),
		bad("no number", "feat/x"),
		bad("empty", ""),
		bad("unknown token", "{number}-{foo}"),
		bad("branch token not allowed", "{branch}/{number}"),
		bad("unclosed brace", "feat/{number"),
		bad("space", "feat {number}"),
		bad("double dot", "feat..{number}"),
		bad("leading slash", "/{number}"),
		bad("trailing .lock", "{number}.lock"),
		bad("101 runes", "{number}"+strings.Repeat("a", 93)),
	})
}

// CT-28 / EC-06: etcBranchName (토큰 금지 · git ref 규칙 · ≤100 rune · "" 금지)
func TestValidate_EtcBranchName_CT28(t *testing.T) {
	ok := func(name, v string) vcase { return vcase{name: name, in: Input{EtcBranchName: sp(v)}} }
	bad := func(name, v string) vcase {
		return vcase{name: name, in: Input{EtcBranchName: sp(v)}, code: "invalid_template", field: "etcBranchName"}
	}
	runValidate(t, allScopes, []vcase{
		ok("etc", "etc"),
		ok("nested", "misc/scratch"),
		ok("100 runes", strings.Repeat("a", 100)),
		bad("space", "a b"),
		bad("empty", ""),
		bad("token", "{number}"),
		bad("brace", "etc}"),
		bad("ref double dot", "a..b"),
		bad("101 runes", strings.Repeat("a", 101)),
	})
}

// CT-11 / EC-20: worktreePath ({branch}|{key} 필수 · 허용 토큰 · 선두 ~ 허용 · ≤512 rune · "" 금지)
func TestValidate_WorktreePath_CT11(t *testing.T) {
	ok := func(name, v string) vcase { return vcase{name: name, in: Input{WorktreePath: sp(v)}} }
	bad := func(name, v string) vcase {
		return vcase{name: name, in: Input{WorktreePath: sp(v)}, code: "invalid_path_template", field: "worktreePath"}
	}
	long := "~/" + strings.Repeat("a", 510-len("{key}")) + "{key}" // 512 rune
	runValidate(t, allScopes, []vcase{
		ok("branch", "~/minmo-workspaces/{owner}/{repo}/{branch}"),
		ok("key", "~/work/{owner}/{repo}/{key}"),
		ok("all tokens", "~/w/{owner}/{repo}/{number}-{slug}/{key}"),
		ok("windows absolute", `D:\w\{key}`),
		ok("512 runes", long),
		bad("no branch/key", "~/w/{owner}/{repo}"),
		bad("empty", ""),
		bad("title not allowed", "~/w/{title}/{key}"),
		bad("unknown token", "~/w/{key}/{oops}"),
		bad("513 runes", long+"a"),
	})
}

// CT-11 / EC-20: mainClonePath (허용 토큰 {owner}{repo} · {branch}{key}{number}{slug} 금지 · ≤512 rune · "" 금지)
func TestValidate_MainClonePath_CT11(t *testing.T) {
	ok := func(name, v string) vcase { return vcase{name: name, in: Input{MainClonePath: sp(v)}} }
	bad := func(name, v string) vcase {
		return vcase{name: name, in: Input{MainClonePath: sp(v)}, code: "invalid_path_template", field: "mainClonePath"}
	}
	runValidate(t, allScopes, []vcase{
		ok("default", "~/minmo-workspaces/{owner}/{repo}/_main"),
		ok("windows", `C:\m\{owner}\{repo}`),
		bad("branch", "~/m/{owner}/{repo}/{branch}"),
		bad("key", "~/m/{owner}/{repo}/{key}"),
		bad("number", "~/m/{number}"),
		bad("slug", "~/m/{slug}"),
		bad("empty", ""),
		bad("unknown token", "~/m/{foo}"),
		bad("513 runes", "~/"+strings.Repeat("a", 511)),
	})
}

// CT-28: postCreateScript (≤65,536 bytes · "" 허용) — 바이트 기준
func TestValidate_PostCreateScript_CT28(t *testing.T) {
	ok := func(name, v string) vcase { return vcase{name: name, in: Input{PostCreateScript: sp(v)}} }
	bad := func(name, v string) vcase {
		return vcase{name: name, in: Input{PostCreateScript: sp(v)}, code: "script_too_large", field: "postCreateScript"}
	}
	runValidate(t, allScopes, []vcase{
		ok("empty = 스크립트 없음", ""),
		ok("65536 bytes", strings.Repeat("x", 65536)),
		bad("65537 bytes", strings.Repeat("x", 65537)),
		bad("multibyte over limit", strings.Repeat("가", 21846)), // 65,538 bytes, 21,846 rune
	})
}

// CT-40: sparsePaths (줄바꿈 구분 상대 디렉터리 · 빈 줄 무시 · "" = 전체 체크아웃)
func TestValidate_SparsePaths_CT40(t *testing.T) {
	ok := func(name, v string) vcase { return vcase{name: name, in: Input{SparsePaths: sp(v)}} }
	bad := func(name, v string) vcase {
		return vcase{name: name, in: Input{SparsePaths: sp(v)}, code: "invalid_sparse_paths", field: "sparsePaths"}
	}
	runValidate(t, allScopes, []vcase{
		ok("empty = 전체", ""),
		ok("dirs", "desktop\npackages/api-client/\n\n  server  "),
		ok("crlf", "desktop\r\nserver"),
		bad("absolute", "/etc"),
		bad("drive", "C:/x"),
		bad("backslash", `desktop\src`),
		bad("parent", "a/../b"),
		bad("dot", "./a"),
		bad("glob", "src/*"),
		bad("negation", "!docs"),
		bad("double slash", "a//b"),
		bad("101 lines", strings.Repeat("a\n", 100)+"a"),
		bad("4097 bytes", strings.Repeat("a", 4097)),
	})
}

// CT-28 / A-P19: org/project 의 nil 은 상속이므로 모두 nil 이어도 유효
func TestValidate_AllNilInherit_CT28(t *testing.T) {
	for _, sc := range []Scope{ScopeOrg, ScopeProject} {
		if code, field := ValidateInput(sc, Input{}); code != "" || field != "" {
			t.Errorf("[%s] all nil: got (%q,%q), want valid", sc, code, field)
		}
	}
}

// CT-29 / EC-22: 전역은 5필드 모두 non-null — nil 이면 선언 순서 첫 필드로 global_requires_all_fields
func TestValidate_GlobalRequiresAllFields_CT29(t *testing.T) {
	full := fillGlobal(Input{})
	if code, field := ValidateInput(ScopeGlobal, full); code != "" || field != "" {
		t.Errorf("full global: got (%q,%q), want valid", code, field)
	}
	cases := []struct {
		field string
		clear func(*Input)
	}{
		{"branchTemplate", func(in *Input) { in.BranchTemplate = nil }},
		{"etcBranchName", func(in *Input) { in.EtcBranchName = nil }},
		{"worktreePath", func(in *Input) { in.WorktreePath = nil }},
		{"mainClonePath", func(in *Input) { in.MainClonePath = nil }},
		{"postCreateScript", func(in *Input) { in.PostCreateScript = nil }},
	}
	for _, c := range cases {
		in := fillGlobal(Input{})
		c.clear(&in)
		if code, field := ValidateInput(ScopeGlobal, in); code != "global_requires_all_fields" || field != c.field {
			t.Errorf("global nil %s: got (%q,%q)", c.field, code, field)
		}
	}
	noSparse := fillGlobal(Input{})
	noSparse.SparsePaths = nil
	if code, field := ValidateInput(ScopeGlobal, noSparse); code != "" || field != "" {
		t.Errorf("global nil sparsePaths (v2.6 이전 클라이언트): got (%q,%q), want valid", code, field)
	}
	if code, field := ValidateInput(ScopeGlobal, Input{}); code != "global_requires_all_fields" || field != "branchTemplate" {
		t.Errorf("global all nil: got (%q,%q), want first field branchTemplate", code, field)
	}
}

// CT-10·CT-11(검증 순서): 여러 위반이 있으면 선언 순서상 첫 1건만
func TestValidate_FirstViolationOnly_CT10_CT11(t *testing.T) {
	in := Input{
		BranchTemplate:   sp("feat/x"),
		WorktreePath:     sp("~/w"),
		PostCreateScript: sp(strings.Repeat("x", 65537)),
	}
	if code, field := ValidateInput(ScopeOrg, in); code != "invalid_template" || field != "branchTemplate" {
		t.Errorf("got (%q,%q), want (invalid_template, branchTemplate)", code, field)
	}
	in = Input{WorktreePath: sp("~/w"), MainClonePath: sp("~/m/{branch}")}
	if code, field := ValidateInput(ScopeProject, in); code != "invalid_path_template" || field != "worktreePath" {
		t.Errorf("got (%q,%q), want (invalid_path_template, worktreePath)", code, field)
	}
}
