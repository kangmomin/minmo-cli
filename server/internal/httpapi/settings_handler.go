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

// PCHeader 는 PC 별 설정을 쓰는 클라이언트가 보내는 PC 식별자(UUID) 헤더다.
// 있으면 작업 폴더 경로·생성 후 스크립트 같은 값을 그 PC 의 것으로 읽고 쓴다(settings.GetForDevice).
// 원격 접속 기기 토큰 헤더(x-minmo-device, 데스크탑 remote.rs)와 다른 것이다.
const PCHeader = "X-Minmo-Pc"

var rePC = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// pcID 는 PCHeader 값을 꺼낸다. 없으면 ""(함께 쓰는 값), 형식이 틀리면 400.
func pcID(r *http.Request) (string, *apiError) {
	v := r.Header.Get(PCHeader)
	if v == "" {
		return "", nil
	}
	if !rePC.MatchString(v) {
		return "", badRequest(CodeInvalidPathParam, "pc")
	}
	return v, nil
}

// getRecord 는 pc 가 있으면 그 PC 의 값으로 읽는다.
func (a *api) getRecord(r *http.Request, userID, pc string, scope settings.Scope, owner, repo string) (settings.Record, error) {
	if pc != "" {
		return settings.GetForDevice(r.Context(), a.db, userID, pc, scope, owner, repo)
	}
	return settings.Get(r.Context(), a.db, userID, scope, owner, repo)
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
		pc, e := pcID(r)
		if e != nil {
			writeAPIError(w, e)
			return
		}
		rec, err := a.getRecord(r, s.userID, pc, scope, owner, repo)
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
		pc, e := pcID(r)
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
		if scope == settings.ScopeGlobal && (in.SparsePaths == nil || in.PostCreateScriptPosix == nil || in.IgnoredCopyExclude == nil) {
			// 나중에 추가된 필드는 이전 클라이언트가 보내지 않는다 — 전역은 저장된 값을 유지하고, 없으면 ""
			cur, err := a.getRecord(r, s.userID, pc, scope, owner, repo)
			if err != nil {
				a.internal(w, r, err)
				return
			}
			keep := func(in **string, stored *string) {
				if *in != nil {
					return
				}
				v := ""
				if stored != nil {
					v = *stored
				}
				*in = &v
			}
			keep(&in.SparsePaths, cur.SparsePaths)
			keep(&in.PostCreateScriptPosix, cur.PostCreateScriptPosix)
			if in.IgnoredCopyExclude == nil {
				// 저장값도 없으면 "" (전부 복사)가 아니라 기본 제외 목록
				v := cur.Values().IgnoredCopyExclude
				in.IgnoredCopyExclude = &v
			}
		}
		var rec settings.Record
		var err error
		if pc != "" {
			rec, err = settings.UpsertForDevice(r.Context(), a.db, s.userID, pc, scope, owner, repo, in, a.now())
		} else {
			rec, err = settings.Upsert(r.Context(), a.db, s.userID, scope, owner, repo, in, a.now())
		}
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
	pc, e := pcID(r)
	if e != nil {
		writeAPIError(w, e)
		return
	}
	var eff settings.Effective
	var err error
	if pc != "" {
		eff, err = settings.GetEffectiveForDevice(r.Context(), a.db, s.userID, pc, owner, repo)
	} else {
		eff, err = settings.GetEffective(r.Context(), a.db, s.userID, owner, repo)
	}
	if err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, eff)
}
