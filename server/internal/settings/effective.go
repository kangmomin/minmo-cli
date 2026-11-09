package settings

// Merge 는 global ← org ← project 순으로 non-nil 값을 덮어써 effective 값과 출처를 계산한다.
// `""`(postCreateScript)도 non-nil 이므로 override 로 취급한다.
func Merge(global Values, org, project Input) Effective {
	return Effective{}
}
