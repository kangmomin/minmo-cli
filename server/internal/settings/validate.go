package settings

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// 계약 "검증 규칙 (non-null 값, 모든 scope 동일)" 표의 상수.
const (
	maxBranchRunes   = 100
	maxPathRunes     = 512
	maxScriptBytes   = 65536
	codeRequiresAll  = "global_requires_all_fields"
	codeTemplate     = "invalid_template"
	codePathTemplate = "invalid_path_template"
	codeScript       = "script_too_large"
)

var (
	branchTokens       = map[string]bool{"number": true, "slug": true, "title": true}
	worktreePathTokens = map[string]bool{"owner": true, "repo": true, "branch": true, "key": true, "number": true, "slug": true}
	mainClonePathToken = map[string]bool{"owner": true, "repo": true}

	// 샘플 치환(number=1, slug=x, title=x) 후 git ref 규칙을 검사한다.
	branchSample = strings.NewReplacer("{number}", "1", "{slug}", "x", "{title}", "x")
)

// ValidateInput 은 계약 검증 규칙표를 선언 순서(branchTemplate → etcBranchName → worktreePath →
// mainClonePath → postCreateScript)로 적용해 첫 위반 1건의 (code, field)를 반환한다. 위반이 없으면 ("", "").
// scope 가 global 이면 nil 필드는 global_requires_all_fields 이다.
func ValidateInput(scope Scope, in Input) (code, field string) {
	fields := []struct {
		name  string
		value *string
		check func(string) string
	}{
		{"branchTemplate", in.BranchTemplate, checkBranchTemplate},
		{"etcBranchName", in.EtcBranchName, checkEtcBranchName},
		{"worktreePath", in.WorktreePath, checkWorktreePath},
		{"mainClonePath", in.MainClonePath, checkMainClonePath},
		{"postCreateScript", in.PostCreateScript, checkPostCreateScript},
	}
	for _, f := range fields {
		if f.value == nil {
			if scope == ScopeGlobal {
				return codeRequiresAll, f.name
			}
			continue // org/project 의 nil 은 상속
		}
		if c := f.check(*f.value); c != "" {
			return c, f.name
		}
	}
	return "", ""
}

func checkBranchTemplate(v string) string {
	if v == "" || utf8.RuneCountInString(v) > maxBranchRunes {
		return codeTemplate
	}
	tokens, ok := parseTokens(v)
	if !ok || !allAllowed(tokens, branchTokens) || !slices.Contains(tokens, "number") {
		return codeTemplate
	}
	if !isValidRef(branchSample.Replace(v)) {
		return codeTemplate
	}
	return ""
}

func checkEtcBranchName(v string) string {
	if v == "" || utf8.RuneCountInString(v) > maxBranchRunes || strings.ContainsAny(v, "{}") || !isValidRef(v) {
		return codeTemplate
	}
	return ""
}

func checkWorktreePath(v string) string {
	if v == "" || utf8.RuneCountInString(v) > maxPathRunes {
		return codePathTemplate
	}
	tokens, ok := parseTokens(v)
	if !ok || !allAllowed(tokens, worktreePathTokens) || !(slices.Contains(tokens, "branch") || slices.Contains(tokens, "key")) {
		return codePathTemplate
	}
	return ""
}

func checkMainClonePath(v string) string {
	if v == "" || utf8.RuneCountInString(v) > maxPathRunes {
		return codePathTemplate
	}
	tokens, ok := parseTokens(v)
	if !ok || !allAllowed(tokens, mainClonePathToken) {
		return codePathTemplate
	}
	return ""
}

func checkPostCreateScript(v string) string {
	if len(v) > maxScriptBytes { // 바이트 기준(rune 아님)
		return codeScript
	}
	return ""
}

// parseTokens 는 `{name}` 토큰 이름 목록을 반환한다. 닫히지 않은 `{` 가 있으면 ok=false.
// 홀로 닫는 `}` 는 허용한다 — 계약은 닫히지 않은 `{`·미지 토큰만 금지한다.
func parseTokens(s string) (tokens []string, ok bool) {
	for {
		open := strings.IndexByte(s, '{')
		if open < 0 {
			return tokens, true
		}
		end := strings.IndexByte(s[open+1:], '}')
		if end < 0 {
			return nil, false
		}
		tokens = append(tokens, s[open+1:open+1+end])
		s = s[open+1+end+1:]
	}
}

func allAllowed(tokens []string, allowed map[string]bool) bool {
	for _, t := range tokens {
		if !allowed[t] {
			return false
		}
	}
	return true
}

// isValidRef 는 계약의 git ref 규칙표를 만족하는지 판정한다.
// 공백·제어문자·`..`·`~`·`^`·`:`·`?`·`*`·`[`·`\`·`@{` 금지, 선두/말미 `/`·`//`·말미 `.`·`.lock` 금지, `@` 단독 금지.
func isValidRef(ref string) bool {
	if ref == "" || ref == "@" {
		return false
	}
	if strings.HasPrefix(ref, "/") || strings.HasSuffix(ref, "/") ||
		strings.HasSuffix(ref, ".") || strings.HasSuffix(ref, ".lock") {
		return false
	}
	if strings.Contains(ref, "..") || strings.Contains(ref, "//") || strings.Contains(ref, "@{") {
		return false
	}
	for _, r := range ref {
		if unicode.IsSpace(r) || unicode.IsControl(r) || strings.ContainsRune(`~^:?*[\`, r) {
			return false
		}
	}
	return true
}
