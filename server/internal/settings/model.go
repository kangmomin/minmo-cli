// Package settings 는 전역→조직→프로젝트 3단계 설정의 모델·검증·병합·저장을 담당한다.
package settings

// Scope 는 설정 저장 단위이자 effective 의 출처 값이다.
// 값 집합의 정본: migrations/0001_init.up.sql settings.scope CHECK 제약 · 계약 Effective.sources.
type Scope string

const (
	ScopeGlobal  Scope = "global"
	ScopeOrg     Scope = "org"
	ScopeProject Scope = "project"
)

// Values 는 5개 필드가 모두 확정된 설정 값(전역 레코드, effective.values).
type Values struct {
	BranchTemplate   string `json:"branchTemplate"`
	EtcBranchName    string `json:"etcBranchName"`
	WorktreePath     string `json:"worktreePath"`
	MainClonePath    string `json:"mainClonePath"`
	PostCreateScript string `json:"postCreateScript"`
}

// Input 은 nullable 5필드(nil = 상속/미지정). org/project 저장 행과 PUT 입력 모두에 쓴다.
type Input struct {
	BranchTemplate   *string `json:"branchTemplate"`
	EtcBranchName    *string `json:"etcBranchName"`
	WorktreePath     *string `json:"worktreePath"`
	MainClonePath    *string `json:"mainClonePath"`
	PostCreateScript *string `json:"postCreateScript"`
}

// Record 는 저장된 설정 행이다. 행이 없으면 모든 필드 nil · UpdatedAt nil.
type Record struct {
	Input
	UpdatedAt *int64 // epoch ms
}

// Sources 는 effective 의 필드별 출처. 5키가 항상 존재한다.
type Sources struct {
	BranchTemplate   Scope `json:"branchTemplate"`
	EtcBranchName    Scope `json:"etcBranchName"`
	WorktreePath     Scope `json:"worktreePath"`
	MainClonePath    Scope `json:"mainClonePath"`
	PostCreateScript Scope `json:"postCreateScript"`
}

// Effective 는 E12 응답 본문 `{values, sources}` 이다.
type Effective struct {
	Values  Values  `json:"values"`
	Sources Sources `json:"sources"`
}

// Defaults 는 신규 사용자 전역 설정 기본값을 반환한다(계약 "전역 기본값").
func Defaults() Values {
	return Values{
		BranchTemplate:   "issue/{number}-{slug}",
		EtcBranchName:    "etc",
		WorktreePath:     "~/minmo-workspaces/{owner}/{repo}/{branch}",
		MainClonePath:    "~/minmo-workspaces/{owner}/{repo}/_main",
		PostCreateScript: "",
	}
}
