// Package githubmock 은 테스트·E2E 용 GitHub OAuth/API mock 이다(testutil 과 cmd/githubmock 공용).
//
// 동작:
//   - GET  /login/oauth/authorize?redirect_uri&state&code_challenge&code_challenge_method=S256
//     → 302 `{redirect_uri}?code=<발급 code>&state=<state>`. 발급 code 는 code_challenge 에 묶이고 사용자 octocat 으로 교환된다.
//   - POST /login/oauth/access_token (form 또는 JSON: code, code_verifier, client_id, client_secret)
//     · authorize 로 발급된 code: S256(code_verifier) == code_challenge 일 때만 TokenOK, 아니면 bad_verification_code (1회용)
//     · CodeOK → TokenOK, CodeUser2 → TokenUser2 (PKCE 검사 없음)
//     · CodeGitHubDown → HTTP 500
//     · 그 외 → 200 `{"error":"bad_verification_code"}`
//   - GET  /user (Authorization: Bearer|token <access token>)
//     · TokenOK → {id: 583231, login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4"}
//     · TokenUser2 → {id: 480938, login: "hubot", avatar_url: null}
//     · 그 외 → 401
package githubmock

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

const (
	CodeOK         = "mock-code-ok"
	CodeUser2      = "mock-code-user2"
	CodeGitHubDown = "mock-code-5xx"

	TokenOK    = "gho_mock_token"
	TokenUser2 = "gho_mock_token2"
)

var users = map[string]map[string]any{
	TokenOK:    {"id": 583231, "login": "octocat", "avatar_url": "https://avatars.githubusercontent.com/u/583231?v=4"},
	TokenUser2: {"id": 480938, "login": "hubot", "avatar_url": nil},
}

type mock struct {
	mu     sync.Mutex
	issued map[string]string // authorize 발급 code → code_challenge
}

// NewHandler 는 GitHub mock http.Handler 를 만든다. 핸들러마다 발급 code 상태를 따로 가진다.
func NewHandler() http.Handler {
	m := &mock{issued: map[string]string{}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /login/oauth/authorize", m.authorize)
	mux.HandleFunc("POST /login/oauth/access_token", m.accessToken)
	mux.HandleFunc("GET /user", m.user)
	return mux
}

func (m *mock) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	redirect, err := url.Parse(q.Get("redirect_uri"))
	if err != nil || redirect.Scheme == "" || q.Get("code_challenge") == "" || q.Get("code_challenge_method") != "S256" {
		http.Error(w, "mock authorize: redirect_uri and S256 code_challenge required", http.StatusBadRequest)
		return
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	code := "mock-pkce-" + hex.EncodeToString(b)
	m.mu.Lock()
	m.issued[code] = q.Get("code_challenge")
	m.mu.Unlock()

	rq := redirect.Query()
	rq.Set("code", code)
	rq.Set("state", q.Get("state"))
	redirect.RawQuery = rq.Encode()
	http.Redirect(w, r, redirect.String(), http.StatusFound)
}

func (m *mock) accessToken(w http.ResponseWriter, r *http.Request) {
	var code, verifier string
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		code, verifier = body["code"], body["code_verifier"]
	} else {
		_ = r.ParseForm()
		code, verifier = r.PostFormValue("code"), r.PostFormValue("code_verifier")
	}

	m.mu.Lock()
	challenge, pkce := m.issued[code]
	delete(m.issued, code)
	m.mu.Unlock()

	token := ""
	switch {
	case pkce:
		// 검증 대상 코드(서버 auth.Challenge)를 재사용하지 않고 독립 계산해 PKCE 왕복을 실제로 검증한다.
		sum := sha256.Sum256([]byte(verifier))
		if base64.RawURLEncoding.EncodeToString(sum[:]) == challenge {
			token = TokenOK
		}
	case code == CodeOK:
		token = TokenOK
	case code == CodeUser2:
		token = TokenUser2
	case code == CodeGitHubDown:
		http.Error(w, "mock github down", http.StatusInternalServerError)
		return
	}
	if token == "" {
		writeJSON(w, http.StatusOK, map[string]any{"error": "bad_verification_code", "error_description": "The code passed is incorrect or expired."})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"access_token": token, "token_type": "bearer", "scope": "repo,read:org,read:user"})
}

func (m *mock) user(w http.ResponseWriter, r *http.Request) {
	auth := r.Header.Get("Authorization")
	tok := strings.TrimPrefix(strings.TrimPrefix(auth, "Bearer "), "token ")
	u, ok := users[tok]
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"message": "Bad credentials"})
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
