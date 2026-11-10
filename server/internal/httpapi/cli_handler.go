package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/kangmomin/minmo-cli/server/internal/auth"
	"github.com/kangmomin/minmo-cli/server/internal/timefmt"
)

// maxSessionLabelRunes 는 원격 CLI 세션 이름(보통 호스트명) 상한이다.
const maxSessionLabelRunes = 100

// E17 POST /me/cli-codes — 원격 CLI 로그인용 1회용 코드(10분). 사용자당 활성 코드 1개.
func (a *api) issueCLICode(w http.ResponseWriter, r *http.Request, s session) {
	code, expiresAt, err := a.cliCodes.Issue(s.userID)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Code      string `json:"code"`
		ExpiresAt string `json:"expiresAt"`
	}{code, timefmt.FormatMs(expiresAt.UnixMilli())})
}

// E18 POST /auth/cli/exchange — 코드를 새 CLI 세션으로 바꾼다(무인증).
// GitHub 토큰은 다시 받지 않는다: 코드를 발급한 데스크탑 로그인의 사용자에게 세션만 추가한다.
func (a *api) exchangeCLICode(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code  *string `json:"code"`
		Label string  `json:"label"`
	}
	if e := decodeJSON(w, r, maxRequestBytes, &in); e != nil {
		writeAPIError(w, e)
		return
	}
	if in.Code == nil {
		writeError(w, http.StatusBadRequest, CodeInvalidJSON, "code")
		return
	}
	userID, ok := a.cliCodes.Take(*in.Code)
	if !ok {
		writeError(w, http.StatusBadRequest, CodeInvalidCLICode, "")
		return
	}
	label := strings.TrimSpace(in.Label)
	if utf8.RuneCountInString(label) > maxSessionLabelRunes {
		label = string([]rune(label)[:maxSessionLabelRunes])
	}
	token, err := auth.CreateKind(r.Context(), a.db, userID, auth.KindCLI, label, a.now())
	if err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Session string `json:"session"`
	}{token})
}

type sessionJSON struct {
	ID         string  `json:"id"`
	Kind       string  `json:"kind"`
	Label      *string `json:"label"`
	CreatedAt  string  `json:"createdAt"`
	LastUsedAt *string `json:"lastUsedAt"`
	Current    bool    `json:"current"`
}

// E19 GET /me/sessions — 만료되지 않은 세션 목록(최근 생성 순)
func (a *api) listSessions(w http.ResponseWriter, r *http.Request, s session) {
	list, err := auth.List(r.Context(), a.db, s.userID, a.now())
	if err != nil {
		a.internal(w, r, err)
		return
	}
	out := make([]sessionJSON, 0, len(list))
	for _, x := range list {
		out = append(out, sessionJSON{
			ID:         x.ID,
			Kind:       x.Kind,
			Label:      x.Label,
			CreatedAt:  timefmt.FormatMs(x.CreatedAt),
			LastUsedAt: formatAt(x.LastUsedAt),
			Current:    x.ID == s.id,
		})
	}
	writeJSON(w, http.StatusOK, struct {
		Sessions []sessionJSON `json:"sessions"`
	}{out})
}

// E20 DELETE /me/sessions/{id} — 본인 세션 폐기(현재 세션이면 로그아웃과 같다). 없으면 404.
func (a *api) revokeSession(w http.ResponseWriter, r *http.Request, s session) {
	err := auth.DeleteByID(r.Context(), a.db, s.userID, r.PathValue("id"))
	if errors.Is(err, auth.ErrInvalidSession) {
		writeError(w, http.StatusNotFound, CodeNotFound, "")
		return
	}
	if err != nil {
		a.internal(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
