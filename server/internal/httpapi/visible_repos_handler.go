package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/kangmomin/minmo-cli/server/internal/repofilter"
	"github.com/kangmomin/minmo-cli/server/internal/timefmt"
)

// visibleReposJSON 은 E15/E16 응답이다. repos null = 전체 표시.
type visibleReposJSON struct {
	Repos     []string `json:"repos"`
	UpdatedAt *string  `json:"updatedAt"`
}

func toVisibleReposJSON(f repofilter.Filter) visibleReposJSON {
	return visibleReposJSON{Repos: f.Repos, UpdatedAt: formatAt(f.UpdatedAt)}
}

// E15
func (a *api) getVisibleRepos(w http.ResponseWriter, r *http.Request, s session) {
	f, err := repofilter.Get(r.Context(), a.db, s.userID)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toVisibleReposJSON(f))
}

// E16 — 선택 전체 교체. baseUpdatedAt 은 notes 와 같은 3분기(생략·null·문자열)이며,
// 두 기기(데스크탑·CLI)가 동시에 고쳐도 한쪽 변경이 조용히 사라지지 않게 409 로 알린다.
func (a *api) putVisibleRepos(w http.ResponseWriter, r *http.Request, s session) {
	var in struct {
		// RawMessage 로 받아 키 누락과 null(전체 표시)을 구분한다
		Repos         json.RawMessage `json:"repos"`
		BaseUpdatedAt json.RawMessage `json:"baseUpdatedAt"`
	}
	if e := decodeJSON(w, r, maxRequestBytes, &in); e != nil {
		writeAPIError(w, e)
		return
	}
	if len(in.Repos) == 0 {
		writeError(w, http.StatusBadRequest, CodeInvalidJSON, "repos")
		return
	}
	var repos []string
	if string(in.Repos) != "null" {
		if err := json.Unmarshal(in.Repos, &repos); err != nil {
			writeError(w, http.StatusBadRequest, CodeInvalidJSON, "repos")
			return
		}
		normalized, ok := repofilter.Normalize(repos)
		if !ok {
			writeError(w, http.StatusBadRequest, CodeInvalidVisibleRepos, "repos")
			return
		}
		repos = normalized
	}

	base := repofilter.Base{Kind: repofilter.BaseOmitted}
	switch {
	case len(in.BaseUpdatedAt) == 0:
	case string(in.BaseUpdatedAt) == "null":
		base.Kind = repofilter.BaseNull
	default:
		var ts string
		if err := json.Unmarshal(in.BaseUpdatedAt, &ts); err != nil {
			writeError(w, http.StatusBadRequest, CodeInvalidJSON, "baseUpdatedAt")
			return
		}
		ms, err := timefmt.ParseMs(ts)
		if err != nil {
			writeError(w, http.StatusBadRequest, CodeInvalidBaseUpdatedAt, "")
			return
		}
		base = repofilter.Base{Kind: repofilter.BaseValue, Ms: ms}
	}

	f, err := repofilter.Put(r.Context(), a.db, s.userID, repos, base, a.now())
	if errors.Is(err, repofilter.ErrConflict) {
		writeError(w, http.StatusConflict, CodeConflict, "")
		return
	}
	if err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toVisibleReposJSON(f))
}
