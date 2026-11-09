package httpapi

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/kangmomin/minmo-cli/server/internal/settings"
)

var reOwnerRepo = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)

// pathName 은 owner/repo path 파라미터를 검증하고 저장 키용 소문자로 정규화한다(A-P20).
// `.`·`..` 는 ServeMux 경로 정리(301)와 충돌하므로 거부한다.
func pathName(r *http.Request, name string) (string, *apiError) {
	v := r.PathValue(name)
	if !reOwnerRepo.MatchString(v) || v == "." || v == ".." {
		return "", badRequest(CodeInvalidPathParam, name)
	}
	return strings.ToLower(v), nil
}

// scopeTarget 은 scope 별 저장 키(owner, repo)를 path 에서 꺼낸다(검증 순서 ②: owner → repo).
func scopeTarget(r *http.Request, scope settings.Scope) (owner, repo string, e *apiError) {
	if scope == settings.ScopeGlobal {
		return "", "", nil
	}
	if owner, e = pathName(r, "owner"); e != nil {
		return "", "", e
	}
	if scope == settings.ScopeProject {
		if repo, e = pathName(r, "repo"); e != nil {
			return "", "", e
		}
	}
	return owner, repo, nil
}

// settingsRecordJSON 은 계약 SettingsRecord(5필드 nullable + updatedAt)다.
type settingsRecordJSON struct {
	settings.Input
	UpdatedAt *string `json:"updatedAt"`
}

func toRecordJSON(rec settings.Record) settingsRecordJSON {
	return settingsRecordJSON{Input: rec.Input, UpdatedAt: formatAt(rec.UpdatedAt)}
}

// E6 · E8 · E10
func (a *api) getSettings(scope settings.Scope) func(http.ResponseWriter, *http.Request, session) {
	return func(w http.ResponseWriter, r *http.Request, s session) {
		owner, repo, e := scopeTarget(r, scope)
		if e != nil {
			writeAPIError(w, e)
			return
		}
		rec, err := settings.Get(r.Context(), a.db, s.userID, scope, owner, repo)
		if err != nil {
			a.internal(w, r, err)
			return
		}
		if scope == settings.ScopeGlobal && rec.UpdatedAt == nil {
			a.internal(w, r, settings.ErrGlobalMissing)
			return
		}
		writeJSON(w, http.StatusOK, toRecordJSON(rec))
	}
}

// E7 · E9 · E11 — 검증 순서: ① 401(authed) ② path ③ JSON 디코드/타입 ④ 필드 첫 위반 1건.
func (a *api) putSettings(scope settings.Scope) func(http.ResponseWriter, *http.Request, session) {
	return func(w http.ResponseWriter, r *http.Request, s session) {
		owner, repo, e := scopeTarget(r, scope)
		if e != nil {
			writeAPIError(w, e)
			return
		}
		var in settings.Input
		if e := decodeJSON(w, r, maxRequestBytes, &in); e != nil {
			writeAPIError(w, e)
			return
		}
		if code, field := settings.ValidateInput(scope, in); code != "" {
			writeError(w, http.StatusBadRequest, ErrorCode(code), field)
			return
		}
		rec, err := settings.Upsert(r.Context(), a.db, s.userID, scope, owner, repo, in, a.now())
		if err != nil {
			a.internal(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, toRecordJSON(rec))
	}
}

// E12
func (a *api) getEffective(w http.ResponseWriter, r *http.Request, s session) {
	owner, repo, e := scopeTarget(r, settings.ScopeProject)
	if e != nil {
		writeAPIError(w, e)
		return
	}
	eff, err := settings.GetEffective(r.Context(), a.db, s.userID, owner, repo)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, eff)
}
