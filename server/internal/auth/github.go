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

// GitHub 외부 호출 실패 분류(계약 E2 ④).
var (
	// ErrBadCode 는 GitHub 가 code 를 거부한 경우(bad_verification_code) → 400 invalid_code.
	ErrBadCode = errors.New("github: bad verification code")
	// ErrGitHubUnavailable 은 네트워크 오류·5xx·그 외 GitHub 오류 → 502 github_unavailable.
	ErrGitHubUnavailable = errors.New("github: unavailable")
)

// OAuthScope 는 authorize 요청 scope 이다(계약 "GitHub 외부 호출").
const OAuthScope = "repo read:org read:user"

const maxGitHubResponse = 1 << 20

// GitHubUser 는 GET /user 응답 중 서버가 쓰는 필드다.
type GitHubUser struct {
	ID        int64   `json:"id"`
	Login     string  `json:"login"`
	AvatarURL *string `json:"avatar_url"`
}

// GitHubClient 는 `{OAuthBase}/login/oauth/access_token` 과 `{APIBase}/user` 만 호출한다.
type GitHubClient struct {
	OAuthBase    string
	APIBase      string
	ClientID     string
	ClientSecret string
	RedirectURI  string
	HTTP         *http.Client
}

// AuthorizeURL 은 PKCE(S256) authorize URL 을 만든다.
func (c *GitHubClient) AuthorizeURL(state, challenge string) string {
	q := url.Values{
		"client_id":             {c.ClientID},
		"redirect_uri":          {c.RedirectURI},
		"scope":                 {OAuthScope},
		"state":                 {state},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
	}
	return c.OAuthBase + "/login/oauth/authorize?" + q.Encode()
}

// Exchange 는 code + code_verifier 를 access token 으로 교환한다.
func (c *GitHubClient) Exchange(ctx context.Context, code, verifier string) (string, error) {
	form := url.Values{
		"client_id":     {c.ClientID},
		"client_secret": {c.ClientSecret},
		"code":          {code},
		"code_verifier": {verifier},
		"redirect_uri":  {c.RedirectURI},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.OAuthBase+"/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	var body struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := c.doJSON(req, &body); err != nil {
		return "", err
	}
	switch {
	case body.Error == "bad_verification_code":
		return "", ErrBadCode
	case body.Error != "" || body.AccessToken == "":
		// [Assumption] 계약은 bad_verification_code 외 GitHub 오류(client 자격 불일치 등)를 별도 코드로 두지 않아 github_unavailable 로 분류
		return "", fmt.Errorf("%w: token exchange error %q", ErrGitHubUnavailable, body.Error)
	}
	return body.AccessToken, nil
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
		return GitHubUser{}, fmt.Errorf("%w: /user response lacks id/login", ErrGitHubUnavailable)
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
		return fmt.Errorf("%w: decode %s: %v", ErrGitHubUnavailable, req.URL.Path, err)
	}
	return nil
}
