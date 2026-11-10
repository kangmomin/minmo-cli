package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"

	"github.com/kangmomin/minmo-cli/server/internal/note"
	"github.com/kangmomin/minmo-cli/server/internal/settings"
	"github.com/kangmomin/minmo-cli/server/internal/timefmt"
)

// maxNoteBodyBytes 는 디코딩 후 body 의 UTF-8 바이트 상한이다(1 MiB).
const maxNoteBodyBytes = 1 << 20

var reIssueKey = regexp.MustCompile(`^(etc|[1-9][0-9]{0,9})$`)

type notesJSON struct {
	Body      string  `json:"body"`
	UpdatedAt *string `json:"updatedAt"`
}

// notesConflictJSON 은 409 flat body `{error:"conflict", body, updatedAt}` 다.
type notesConflictJSON struct {
	Error     ErrorCode `json:"error"`
	Body      string    `json:"body"`
	UpdatedAt *string   `json:"updatedAt"`
}

func formatAt(ms *int64) *string {
	if ms == nil {
		return nil
	}
	ts := timefmt.FormatMs(*ms)
	return &ts
}

// noteKey 는 검증 순서 ② owner → repo → key 로 path 를 검증한다.
func noteKey(r *http.Request, s session) (note.Key, *apiError) {
	owner, repo, e := scopeTarget(r, settings.ScopeProject)
	if e != nil {
		return note.Key{}, e
	}
	key := r.PathValue("key")
	if !reIssueKey.MatchString(key) {
		return note.Key{}, badRequest(CodeInvalidIssueKey, "")
	}
	return note.Key{UserID: s.userID, Owner: owner, Repo: repo, IssueKey: key}, nil
}

// E13
func (a *api) getNotes(w http.ResponseWriter, r *http.Request, s session) {
	k, e := noteKey(r, s)
	if e != nil {
		writeAPIError(w, e)
		return
	}
	n, err := note.Get(r.Context(), a.db, k)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, notesJSON{Body: n.Body, UpdatedAt: formatAt(n.UpdatedAt)})
}

// E14 — ③ 디코드/타입(body 누락 포함) → ④ body 크기 → baseUpdatedAt 형식 → 저장(3분기, 409 flat).
func (a *api) putNotes(w http.ResponseWriter, r *http.Request, s session) {
	k, e := noteKey(r, s)
	if e != nil {
		writeAPIError(w, e)
		return
	}
	var in struct {
		Body *string `json:"body"`
		// RawMessage 로 받아 생략(len 0)·null·문자열 3분기를 구분한다.
		BaseUpdatedAt json.RawMessage `json:"baseUpdatedAt"`
	}
	if e := decodeJSON(w, r, maxNotesRequestBytes, &in); e != nil {
		writeAPIError(w, e)
		return
	}
	if in.Body == nil {
		writeError(w, http.StatusBadRequest, CodeInvalidJSON, "body")
		return
	}
	base := note.Base{Kind: note.BaseOmitted}
	var baseStr string
	switch {
	case len(in.BaseUpdatedAt) == 0:
	case string(in.BaseUpdatedAt) == "null":
		base.Kind = note.BaseNull
	default:
		if err := json.Unmarshal(in.BaseUpdatedAt, &baseStr); err != nil {
			writeError(w, http.StatusBadRequest, CodeInvalidJSON, "baseUpdatedAt")
			return
		}
		base.Kind = note.BaseValue
	}

	if len(*in.Body) > maxNoteBodyBytes {
		writeError(w, http.StatusBadRequest, CodeBodyTooLarge, "")
		return
	}
	if base.Kind == note.BaseValue {
		ms, err := timefmt.ParseMs(baseStr)
		if err != nil {
			writeError(w, http.StatusBadRequest, CodeInvalidBaseUpdatedAt, "")
			return
		}
		base.Ms = ms
	}

	n, err := note.Put(r.Context(), a.db, k, *in.Body, base, a.now())
	var conflict *note.ErrConflict
	if errors.As(err, &conflict) {
		writeJSON(w, http.StatusConflict, notesConflictJSON{
			Error:     CodeConflict,
			Body:      conflict.Current.Body,
			UpdatedAt: formatAt(conflict.Current.UpdatedAt),
		})
		return
	}
	if err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, notesJSON{Body: n.Body, UpdatedAt: formatAt(n.UpdatedAt)})
}
