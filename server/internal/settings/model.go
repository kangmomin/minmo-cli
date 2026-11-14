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

// Values 는 7개 필드가 모두 확정된 설정 값(전역 레코드, effective.values).
type Values struct {
	BranchTemplate   string `json:"branchTemplate"`
	EtcBranchName    string `json:"etcBranchName"`
	WorktreePath     string `json:"worktreePath"`
	MainClonePath    string `json:"mainClonePath"`
	PostCreateScript string `json:"postCreateScript"`
	// SparsePaths 는 줄바꿈으로 구분한 sparse-checkout(cone) 디렉터리 목록. 빈 값이면 전체 체크아웃
	SparsePaths string `json:"sparsePaths"`
	// PostCreateScriptPosix 는 Linux/macOS(sh) 생성 후 스크립트. PostCreateScript 는 Windows(PowerShell) 용이다
	PostCreateScriptPosix string `json:"postCreateScriptPosix"`
	// IgnoredCopyExclude 는 새 worktree 에 무시된 파일을 가져올 때 뺄 폴더·파일 이름(줄바꿈 구분). "off" 면 가져오지 않는다
	IgnoredCopyExclude string `json:"ignoredCopyExclude"`
}

// Input 은 nullable 7필드(nil = 상속/미지정). org/project 저장 행과 PUT 입력 모두에 쓴다.
type Input struct {
	BranchTemplate        *string `json:"branchTemplate"`
	EtcBranchName         *string `json:"etcBranchName"`
	WorktreePath          *string `json:"worktreePath"`
	MainClonePath         *string `json:"mainClonePath"`
	PostCreateScript      *string `json:"postCreateScript"`
	SparsePaths           *string `json:"sparsePaths"`
	PostCreateScriptPosix *string `json:"postCreateScriptPosix"`
	IgnoredCopyExclude    *string `json:"ignoredCopyExclude"`
}

// Record 는 저장된 설정 행이다. 행이 없으면 모든 필드 nil · UpdatedAt nil.
type Record struct {
	Input
	UpdatedAt *int64 // epoch ms
}

// Sources 는 effective 의 필드별 출처. 7키가 항상 존재한다.
type Sources struct {
	BranchTemplate        Scope `json:"branchTemplate"`
	EtcBranchName         Scope `json:"etcBranchName"`
	WorktreePath          Scope `json:"worktreePath"`
	MainClonePath         Scope `json:"mainClonePath"`
	PostCreateScript      Scope `json:"postCreateScript"`
	SparsePaths           Scope `json:"sparsePaths"`
	PostCreateScriptPosix Scope `json:"postCreateScriptPosix"`
	IgnoredCopyExclude    Scope `json:"ignoredCopyExclude"`
}

// Effective 는 E12 응답 본문 `{values, sources}` 이다.
type Effective struct {
	Values  Values  `json:"values"`
	Sources Sources `json:"sources"`
}

// Defaults 는 신규 사용자 전역 설정 기본값을 반환한다(계약 "전역 기본값").
func Defaults() Values {
	return Values{
		BranchTemplate:        "issue/{number}-{slug}",
		EtcBranchName:         "etc",
		WorktreePath:          "~/minmo-workspaces/{owner}/{repo}/{branch}",
		MainClonePath:         "~/minmo-workspaces/{owner}/{repo}/_main",
		PostCreateScript:      "",
		SparsePaths:           "",
		PostCreateScriptPosix: "",
		IgnoredCopyExclude:    DefaultIgnoredCopyExclude,
	}
}

// DefaultIgnoredCopyExclude 는 의존성·빌드 산출물처럼 크고 다시 만들 수 있는 폴더다(마이그레이션 0006 과 같은 값).
const DefaultIgnoredCopyExclude = "node_modules\ntarget\ndist\nbuild\nout\n.next\n.nuxt\n.venv\nvenv\n__pycache__\n.gradle\n.turbo\n.cache\ncoverage"
