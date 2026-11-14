package settings

// Merge 는 global ← org ← project 순으로 non-nil 값을 덮어써 effective 값과 출처를 계산한다.
// `""`(postCreateScript·sparsePaths·postCreateScriptPosix)도 non-nil 이므로 override 로 취급한다.
func Merge(global Values, org, project Input) Effective {
	e := Effective{
		Values:  global,
		Sources: Sources{ScopeGlobal, ScopeGlobal, ScopeGlobal, ScopeGlobal, ScopeGlobal, ScopeGlobal, ScopeGlobal, ScopeGlobal},
	}
	for _, layer := range []struct {
		scope Scope
		in    Input
	}{{ScopeOrg, org}, {ScopeProject, project}} {
		apply(&e.Values.BranchTemplate, &e.Sources.BranchTemplate, layer.in.BranchTemplate, layer.scope)
		apply(&e.Values.EtcBranchName, &e.Sources.EtcBranchName, layer.in.EtcBranchName, layer.scope)
		apply(&e.Values.WorktreePath, &e.Sources.WorktreePath, layer.in.WorktreePath, layer.scope)
		apply(&e.Values.MainClonePath, &e.Sources.MainClonePath, layer.in.MainClonePath, layer.scope)
		apply(&e.Values.PostCreateScript, &e.Sources.PostCreateScript, layer.in.PostCreateScript, layer.scope)
		apply(&e.Values.SparsePaths, &e.Sources.SparsePaths, layer.in.SparsePaths, layer.scope)
		apply(&e.Values.PostCreateScriptPosix, &e.Sources.PostCreateScriptPosix, layer.in.PostCreateScriptPosix, layer.scope)
		apply(&e.Values.IgnoredCopyExclude, &e.Sources.IgnoredCopyExclude, layer.in.IgnoredCopyExclude, layer.scope)
	}
	return e
}

func apply(value *string, source *Scope, override *string, scope Scope) {
	if override == nil {
		return
	}
	*value = *override
	*source = scope
}
