package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/kangmomin/minmo-cli/server/internal/auth"
	"github.com/kangmomin/minmo-cli/server/internal/settings"
)

// E1 POST /auth/github/device/start — 기기 코드 로그인을 시작한다.
// 사용자는 verificationUri 에서 userCode 를 입력해 승인하고, 클라이언트는 interval 초마다 E2 로 결과를 확인한다.
func (a *api) startDeviceLogin(w http.ResponseWriter, r *http.Request) {
	if a.cfg.GitHubClientID == "" {
		writeError(w, http.StatusServiceUnavailable, CodeGitHubOAuthNotConfigured, "")
		return
	}
	dc, err := a.gh.RequestDeviceCode(r.Context())
	if err != nil {
		a.githubFail(w, r, err)
		return
	}
	id, interval, err := a.devices.Put(dc)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		DeviceID        string `json:"deviceId"`
		UserCode        string `json:"userCode"`
		VerificationURI string `json:"verificationUri"`
		ExpiresIn       int    `json:"expiresIn"`
		Interval        int    `json:"interval"`
	}{id, dc.UserCode, dc.VerificationURI, dc.ExpiresIn, interval})
}

// devicePollBody 는 E2 응답이다. status 가 "ok" 일 때만 session 이 있다.
type devicePollBody struct {
	Status   string `json:"status"`
	Session  string `json:"session,omitempty"`
	Interval int    `json:"interval,omitempty"`
}

// E2 POST /auth/github/device/poll — 승인 여부를 확인한다. 승인됐으면 사용자·세션을 만들고 세션 토큰을 돌려준다.
// 확인 간격은 서버가 지킨다: 너무 이른 요청은 GitHub 에 묻지 않고 "pending" 으로 답한다.
func (a *api) pollDeviceLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		DeviceID string `json:"deviceId"`
	}
	if e := decodeJSON(w, r, 4<<10, &in); e != nil {
		writeAPIError(w, e)
		return
	}
	state, deviceCode, interval := a.devices.Begin(in.DeviceID)
	switch state {
	case auth.PollGone:
		writeError(w, http.StatusBadRequest, CodeDeviceCodeExpired, "")
		return
	case auth.PollWait:
		writeJSON(w, http.StatusOK, devicePollBody{Status: "pending", Interval: interval})
		return
	}

	ctx := r.Context()
	token, newInterval, err := a.gh.PollDeviceToken(ctx, deviceCode)
	switch {
	case errors.Is(err, auth.ErrAuthorizationPending):
		writeJSON(w, http.StatusOK, devicePollBody{Status: "pending", Interval: a.devices.Finish(in.DeviceID, false, false, 0)})
		return
	case errors.Is(err, auth.ErrSlowDown):
		writeJSON(w, http.StatusOK, devicePollBody{Status: "pending", Interval: a.devices.Finish(in.DeviceID, false, true, newInterval)})
		return
	case errors.Is(err, auth.ErrDeviceExpired):
		a.devices.Finish(in.DeviceID, true, false, 0)
		writeError(w, http.StatusBadRequest, CodeDeviceCodeExpired, "")
		return
	case errors.Is(err, auth.ErrAccessDenied):
		a.devices.Finish(in.DeviceID, true, false, 0)
		writeError(w, http.StatusBadRequest, CodeAccessDenied, "")
		return
	case err != nil:
		// 일시 오류일 수 있다 — 코드는 살려 두어 다음 확인에서 다시 묻는다
		a.devices.Finish(in.DeviceID, false, false, 0)
		a.githubFail(w, r, err)
		return
	}

	// 토큰은 한 번만 받을 수 있다 — 여기서 실패하면 처음부터 다시 로그인해야 하므로 코드를 지운다
	a.devices.Finish(in.DeviceID, true, false, 0)
	session, err := a.completeLogin(ctx, token)
	if err != nil {
		a.githubFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, devicePollBody{Status: "ok", Session: session})
}

// completeLogin 은 GitHub access token 으로 사용자를 확인해 저장(토큰은 암호화)하고 데스크탑 세션을 만든다.
func (a *api) completeLogin(ctx context.Context, accessToken string) (string, error) {
	ghUser, err := a.gh.FetchUser(ctx, accessToken)
	if err != nil {
		return "", err
	}
	enc, err := auth.Seal(a.cfg.TokenKey, []byte(accessToken))
	if err != nil {
		return "", err
	}
	now := a.now()
	userID, err := auth.UpsertUser(ctx, a.db, ghUser, enc, now)
	if err != nil {
		return "", err
	}
	if err := settings.EnsureGlobalDefaults(ctx, a.db, userID, now); err != nil {
		return "", err
	}
	return auth.Create(ctx, a.db, userID, now)
}

// githubFail 은 GitHub 호출 실패를 502 github_unavailable 로, 그 밖의 오류를 500 으로 답한다.
func (a *api) githubFail(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, auth.ErrGitHubUnavailable) {
		slog.Warn("github unavailable", "path", r.URL.Path, "err", err)
		writeError(w, http.StatusBadGateway, CodeGitHubUnavailable, "")
		return
	}
	a.internal(w, r, err)
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
