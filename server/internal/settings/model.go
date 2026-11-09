// Package settings 는 전역→조직→프로젝트 3단계 설정의 모델·검증·병합을 담당한다.
//
// Phase 6.1 Red 스텁: 타입·시그니처만 고정한다. 실제 구현은 Phase 6.2.
package settings

// Scope 는 설정 저장 단위이자 effective 의 출처 값이다.
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

// Defaults 는 신규 사용자 전역 설정 기본값을 반환한다.
func Defaults() Values {
	return Values{}
}
