package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// GitHub 외부 호출 실패 분류.
var (
	// ErrGitHubUnavailable 은 네트워크 오류·5xx·그 외 GitHub 오류 → 502 github_unavailable.
	ErrGitHubUnavailable = errors.New("github: unavailable")
	// ErrAuthorizationPending 은 사용자가 아직 브라우저에서 코드를 승인하지 않은 상태다.
	ErrAuthorizationPending = errors.New("github: authorization pending")
	// ErrSlowDown 은 확인 간격이 너무 짧다는 응답이다 — 간격을 늘려 다시 확인한다.
	ErrSlowDown = errors.New("github: slow down")
	// ErrDeviceExpired 는 기기 코드가 만료(15분)됐거나 이미 쓰인 경우다.
	ErrDeviceExpired = errors.New("github: device code expired")
	// ErrAccessDenied 는 사용자가 브라우저에서 승인을 거부한 경우다.
	ErrAccessDenied = errors.New("github: access denied")
)

// OAuthScope 는 로그인으로 받는 권한 범위다.
const OAuthScope = "repo read:org read:user"

// deviceGrantType 은 기기 코드 방식(RFC 8628)의 grant_type 값이다.
const deviceGrantType = "urn:ietf:params:oauth:grant-type:device_code"

const maxGitHubResponse = 1 << 20

// GitHubUser 는 GET /user 응답 중 서버가 쓰는 필드다.
type GitHubUser struct {
	ID        int64   `json:"id"`
	Login     string  `json:"login"`
	AvatarURL *string `json:"avatar_url"`
}

// DeviceCode 는 `POST /login/device/code` 응답이다. DeviceCode 는 서버만 갖고, UserCode 를 사용자가 브라우저에 입력한다.
type DeviceCode struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	// ExpiresIn·Interval 은 초 단위다
	ExpiresIn int `json:"expires_in"`
	Interval  int `json:"interval"`
}

// GitHubClient 는 기기 코드 방식 로그인에 필요한 GitHub 호출만 한다:
// `{OAuthBase}/login/device/code`, `{OAuthBase}/login/oauth/access_token`, `{APIBase}/user`.
// Client Secret 은 쓰지 않는다 — Client ID 만으로 동작하므로 앱에 넣어 배포할 수 있다.
type GitHubClient struct {
	OAuthBase string
	APIBase   string
	ClientID  string
	HTTP      *http.Client
}

func (c *GitHubClient) postForm(ctx context.Context, path string, form url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.OAuthBase+path, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	return c.doJSON(req, out)
}

// RequestDeviceCode 는 기기 코드를 발급받는다.
func (c *GitHubClient) RequestDeviceCode(ctx context.Context) (DeviceCode, error) {
	var body struct {
		DeviceCode
		Error string `json:"error"`
	}
	if err := c.postForm(ctx, "/login/device/code", url.Values{"client_id": {c.ClientID}, "scope": {OAuthScope}}, &body); err != nil {
		return DeviceCode{}, err
	}
	if body.Error != "" || body.DeviceCode.DeviceCode == "" || body.UserCode == "" || body.VerificationURI == "" {
		// device_flow_disabled(OAuth App 에서 Device Flow 를 켜지 않음)·잘못된 client_id 등
		return DeviceCode{}, fmt.Errorf("%w: 기기 코드 발급 오류 %q", ErrGitHubUnavailable, body.Error)
	}
	return body.DeviceCode, nil
}

// PollDeviceToken 은 사용자가 승인했는지 한 번 확인한다. 승인됐으면 access token 을,
// 아니면 ErrAuthorizationPending·ErrSlowDown(interval = 새 간격, 초)·ErrDeviceExpired·ErrAccessDenied 를 돌려준다.
func (c *GitHubClient) PollDeviceToken(ctx context.Context, deviceCode string) (token string, interval int, err error) {
	var body struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		Interval    int    `json:"interval"`
	}
	form := url.Values{"client_id": {c.ClientID}, "device_code": {deviceCode}, "grant_type": {deviceGrantType}}
	if err := c.postForm(ctx, "/login/oauth/access_token", form, &body); err != nil {
		return "", 0, err
	}
	switch body.Error {
	case "":
		if body.AccessToken == "" {
			return "", 0, fmt.Errorf("%w: 토큰 응답에 access_token 없음", ErrGitHubUnavailable)
		}
		return body.AccessToken, 0, nil
	case "authorization_pending":
		return "", 0, ErrAuthorizationPending
	case "slow_down":
		return "", body.Interval, ErrSlowDown
	case "expired_token", "incorrect_device_code":
		return "", 0, ErrDeviceExpired
	case "access_denied":
		return "", 0, ErrAccessDenied
	default:
		return "", 0, fmt.Errorf("%w: 토큰 확인 오류 %q", ErrGitHubUnavailable, body.Error)
	}
}

// FetchUser 는 access token 으로 GET /user 를 호출한다.
func (c *GitHubClient) FetchUser(ctx context.Context, token string) (GitHubUser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.APIBase+"/user", nil)
	if err != nil {
		return GitHubUser{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")

	var u GitHubUser
	if err := c.doJSON(req, &u); err != nil {
		return GitHubUser{}, err
	}
	if u.ID == 0 || u.Login == "" {
		return GitHubUser{}, fmt.Errorf("%w: /user 응답에 id/login 없음", ErrGitHubUnavailable)
	}
	return u, nil
}

// doJSON 은 요청을 보내 200 JSON 을 out 에 디코드한다. 네트워크·비200·디코드 실패는 ErrGitHubUnavailable.
func (c *GitHubClient) doJSON(req *http.Request, out any) error {
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrGitHubUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxGitHubResponse))
		return fmt.Errorf("%w: %s %s → %d", ErrGitHubUnavailable, req.Method, req.URL.Path, resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxGitHubResponse)).Decode(out); err != nil {
		return fmt.Errorf("%w: %s 응답 디코드 실패: %v", ErrGitHubUnavailable, req.URL.Path, err)
	}
	return nil
}
