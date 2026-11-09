package settings

import (
	"encoding/json"
	"reflect"
	"testing"
)

var testGlobal = Values{
	BranchTemplate:   "issue/{number}-{slug}",
	EtcBranchName:    "etc",
	WorktreePath:     "~/minmo-workspaces/{owner}/{repo}/{branch}",
	MainClonePath:    "~/minmo-workspaces/{owner}/{repo}/_main",
	PostCreateScript: "",
}

func allGlobal() Sources {
	return Sources{ScopeGlobal, ScopeGlobal, ScopeGlobal, ScopeGlobal, ScopeGlobal}
}

// CT-07: 전역 기본값 = `issue/{number}-{slug}` · `etc` · `~/minmo-workspaces/{owner}/{repo}/{branch}` · `~/minmo-workspaces/{owner}/{repo}/_main` · `""`
func TestDefaults_CT07(t *testing.T) {
	if got := Defaults(); got != testGlobal {
		t.Errorf("Defaults() = %+v, want %+v", got, testGlobal)
	}
}

// CT-09: project 가 branchTemplate 만 override → 그 필드만 project, 나머지 global
func TestMerge_ProjectOverride_CT09(t *testing.T) {
	got := Merge(testGlobal, Input{}, Input{BranchTemplate: sp("feat/{number}")})
	wantV := testGlobal
	wantV.BranchTemplate = "feat/{number}"
	wantS := allGlobal()
	wantS.BranchTemplate = ScopeProject
	if got.Values != wantV || got.Sources != wantS {
		t.Errorf("Merge = %+v, want values %+v sources %+v", got, wantV, wantS)
	}
}

// CT-12: org 값은 상속(source org), 같은 필드를 project 가 덮으면 project 우선
func TestMerge_OrgThenProject_CT12(t *testing.T) {
	org := Input{WorktreePath: sp("~/work/{owner}/{repo}/{key}")}
	got := Merge(testGlobal, org, Input{})
	if got.Values.WorktreePath != "~/work/{owner}/{repo}/{key}" || got.Sources.WorktreePath != ScopeOrg {
		t.Errorf("org inherit: %q / %q", got.Values.WorktreePath, got.Sources.WorktreePath)
	}
	if got.Sources.BranchTemplate != ScopeGlobal || got.Values.BranchTemplate != testGlobal.BranchTemplate {
		t.Errorf("untouched field: %q / %q", got.Values.BranchTemplate, got.Sources.BranchTemplate)
	}
	got = Merge(testGlobal, org, Input{WorktreePath: sp("~/p/{key}")})
	if got.Values.WorktreePath != "~/p/{key}" || got.Sources.WorktreePath != ScopeProject {
		t.Errorf("project over org: %q / %q", got.Values.WorktreePath, got.Sources.WorktreePath)
	}
}

// CT-23: org/project 가 모두 nil(null 로 되돌림)이면 global 로 복귀
func TestMerge_NullRevertsToGlobal_CT23(t *testing.T) {
	got := Merge(testGlobal, Input{}, Input{})
	if got.Values != testGlobal || got.Sources != allGlobal() {
		t.Errorf("Merge(nil, nil) = %+v", got)
	}
}

// CT-28: postCreateScript "" 는 override("스크립트 없음") — 상위 값이 있어도 "" 와 source org
func TestMerge_EmptyScriptIsOverride_CT28(t *testing.T) {
	g := testGlobal
	g.PostCreateScript = "npm install"
	got := Merge(g, Input{PostCreateScript: sp("")}, Input{})
	if got.Values.PostCreateScript != "" || got.Sources.PostCreateScript != ScopeOrg {
		t.Errorf("org \"\": %q / %q", got.Values.PostCreateScript, got.Sources.PostCreateScript)
	}
}

// CT-09·CT-12: E12 응답 shape — values·sources 각각 camelCase 5키, sources 값은 global|org|project
func TestEffective_JSONShape_CT09_CT12(t *testing.T) {
	b, err := json.Marshal(Merge(testGlobal, Input{EtcBranchName: sp("misc")}, Input{BranchTemplate: sp("feat/{number}")}))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]map[string]string
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal %s: %v", b, err)
	}
	wantSources := map[string]string{
		"branchTemplate": "project", "etcBranchName": "org", "worktreePath": "global",
		"mainClonePath": "global", "postCreateScript": "global",
	}
	if !reflect.DeepEqual(m["sources"], wantSources) {
		t.Errorf("sources = %v, want %v", m["sources"], wantSources)
	}
	wantValues := map[string]string{
		"branchTemplate": "feat/{number}", "etcBranchName": "misc", "worktreePath": testGlobal.WorktreePath,
		"mainClonePath": testGlobal.MainClonePath, "postCreateScript": "",
	}
	if !reflect.DeepEqual(m["values"], wantValues) {
		t.Errorf("values = %v, want %v", m["values"], wantValues)
	}
}
