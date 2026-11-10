package httpapi

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/kangmomin/minmo-cli/server/internal/auth"
	"github.com/kangmomin/minmo-cli/server/internal/settings"
)

// E1 POST /auth/github/start
func (a *api) startLogin(w http.ResponseWriter, r *http.Request) {
	if a.cfg.GitHubClientID == "" || a.cfg.GitHubClientSecret == "" {
		writeError(w, http.StatusServiceUnavailable, CodeGitHubOAuthNotConfigured, "")
		return
	}
	state, err := auth.NewState()
	if err != nil {
		a.internal(w, r, err)
		return
	}
	verifier, err := auth.NewVerifier()
	if err != nil {
		a.internal(w, r, err)
		return
	}
	a.states.Put(state, verifier)
	writeJSON(w, http.StatusOK, struct {
		AuthorizeURL string `json:"authorizeUrl"`
		State        string `json:"state"`
	}{a.gh.AuthorizeURL(state, auth.Challenge(verifier)), state})
}

// E2 GET /auth/github/callback — 판정 순서 고정: ① state ② error 파라미터 ③ code 누락 ④ 교환·/user.
// 성공은 302 딥링크(본문 없음), 실패는 HTML + meta refresh 딥링크 error(A-P18).
func (a *api) callback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	state := q.Get("state")
	verifier, ok := "", false
	if state != "" {
		verifier, ok = a.states.Take(state)
	}
	if !ok {
		// 검증되지 않은 state 는 딥링크에 되돌려 주지 않는다("state 불명이면 생략").
		a.callbackFail(w, http.StatusBadRequest, CodeInvalidState, "")
		return
	}
	if ghErr := q.Get("error"); ghErr != "" {
		code := CodeInvalidCode
		if ghErr == "access_denied" {
			code = CodeAccessDenied
		}
		a.callbackFail(w, http.StatusBadRequest, code, state)
		return
	}
	code := q.Get("code")
	if code == "" {
		a.callbackFail(w, http.StatusBadRequest, CodeMissingCode, state)
		return
	}

	ctx := r.Context()
	accessToken, err := a.gh.Exchange(ctx, code, verifier)
	if err != nil {
		a.callbackGitHubFail(w, r, err, state)
		return
	}
	ghUser, err := a.gh.FetchUser(ctx, accessToken)
	if err != nil {
		a.callbackGitHubFail(w, r, err, state)
		return
	}

	enc, err := auth.Seal(a.cfg.TokenKey, []byte(accessToken))
	if err != nil {
		a.callbackInternal(w, r, err, state)
		return
	}
	now := a.now()
	userID, err := auth.UpsertUser(ctx, a.db, ghUser, enc, now)
	if err != nil {
		a.callbackInternal(w, r, err, state)
		return
	}
	if err := settings.EnsureGlobalDefaults(ctx, a.db, userID, now); err != nil {
		a.callbackInternal(w, r, err, state)
		return
	}
	token, err := auth.Create(ctx, a.db, userID, now)
	if err != nil {
		a.callbackInternal(w, r, err, state)
		return
	}
	// http.Redirect 는 GET 응답에 HTML 본문을 쓰므로 직접 헤더만 설정한다(계약: body 없음).
	w.Header().Set("Location", a.deepLink(url.Values{"session": {token}, "state": {state}}))
	w.WriteHeader(http.StatusFound)
}

func (a *api) callbackGitHubFail(w http.ResponseWriter, r *http.Request, err error, state string) {
	switch {
	case errors.Is(err, auth.ErrBadCode):
		a.callbackFail(w, http.StatusBadRequest, CodeInvalidCode, state)
	case errors.Is(err, auth.ErrGitHubUnavailable):
		slog.Warn("github unavailable", "path", r.URL.Path, "err", err)
		a.callbackFail(w, http.StatusBadGateway, CodeGitHubUnavailable, state)
	default:
		a.callbackInternal(w, r, err, state)
	}
}

func (a *api) callbackInternal(w http.ResponseWriter, r *http.Request, err error, state string) {
	slog.Error("callback internal error", "path", r.URL.Path, "err", err)
	a.callbackFail(w, http.StatusInternalServerError, CodeInternal, state)
}

func (a *api) deepLink(q url.Values) string {
	sep := "?"
	if strings.Contains(a.cfg.DeepLink, "?") {
		sep = "&"
	}
	return a.cfg.DeepLink + sep + q.Encode()
}

var callbackMessages = map[ErrorCode]string{
	CodeInvalidState:      "로그인 요청이 만료되었거나 유효하지 않습니다. 앱에서 다시 시도하세요.",
	CodeAccessDenied:      "GitHub 승인이 취소되었습니다.",
	CodeInvalidCode:       "GitHub 인증 코드가 유효하지 않습니다. 앱에서 다시 시도하세요.",
	CodeMissingCode:       "GitHub 응답에 인증 코드가 없습니다. 앱에서 다시 시도하세요.",
	CodeGitHubUnavailable: "GitHub 에 연결할 수 없습니다. 잠시 후 다시 시도하세요.",
	CodeInternal:          "서버 내부 오류가 발생했습니다. 잠시 후 다시 시도하세요.",
}

// attrEscaper 는 딥링크를 HTML 속성에 넣을 때 쓴다. 딥링크의 쿼리 값은 url.Values.Encode 로 이미
// 퍼센트 인코딩되어 `&` 는 구분자로만 남으므로 `&` 는 그대로 둔다(계약 테스트가 원문 `&state=` 를 확인).
var attrEscaper = strings.NewReplacer(`"`, "&#34;", `'`, "&#39;", "<", "&lt;", ">", "&gt;")

const callbackPage = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=%[1]s">
<title>minmo 로그인 실패</title>
</head>
<body>
<h1>로그인 실패</h1>
<p>%[2]s</p>
<p>오류 코드: <code>%[3]s</code></p>
<p><a href="%[1]s">minmo 앱으로 돌아가기</a></p>
</body>
</html>
`

// callbackFail 은 E2 실패 HTML 을 쓴다. state 가 "" 이면 딥링크에서 생략한다.
func (a *api) callbackFail(w http.ResponseWriter, status int, code ErrorCode, state string) {
	q := url.Values{"error": {string(code)}}
	if state != "" {
		q.Set("state", state)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, callbackPage, attrEscaper.Replace(a.deepLink(q)), callbackMessages[code], code)
}

// E3 GET /me
func (a *api) me(w http.ResponseWriter, r *http.Request, s session) {
	u, err := auth.GetUser(r.Context(), a.db, s.userID)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		ID          string  `json:"id"`
		GitHubLogin string  `json:"githubLogin"`
		AvatarURL   *string `json:"avatarUrl"`
	}{u.ID, u.GitHubLogin, u.AvatarURL})
}

// E4 GET /me/github-token
func (a *api) githubToken(w http.ResponseWriter, r *http.Request, s session) {
	tok, err := auth.GitHubToken(r.Context(), a.db, a.cfg.TokenKey, s.userID)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		AccessToken string `json:"accessToken"`
	}{tok})
}

// E5 DELETE /auth/session
func (a *api) logout(w http.ResponseWriter, r *http.Request, s session) {
	err := auth.Delete(r.Context(), a.db, s.token)
	if errors.Is(err, auth.ErrInvalidSession) { // 동시 로그아웃 경합
		writeError(w, http.StatusUnauthorized, CodeUnauthorized, "")
		return
	}
	if err != nil {
		a.internal(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
