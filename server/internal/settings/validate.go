package settings

// ValidateInput 은 계약 검증 규칙표를 선언 순서(branchTemplate → etcBranchName → worktreePath →
// mainClonePath → postCreateScript)로 적용해 첫 위반 1건의 (code, field)를 반환한다. 위반이 없으면 ("", "").
// scope 가 global 이면 nil 필드는 global_requires_all_fields 이다.
func ValidateInput(scope Scope, in Input) (code, field string) {
	return "not_implemented", ""
}

// isValidRef 는 계약의 git ref 규칙표를 만족하는지 판정한다.
func isValidRef(ref string) bool {
	return false
}
