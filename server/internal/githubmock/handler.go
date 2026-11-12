// Package githubmock 은 테스트·E2E 용 GitHub OAuth(기기 코드 방식)/API mock 이다(testutil 과 cmd/githubmock 공용).
//
// 동작:
//   - POST /login/device/code (form: client_id, scope)
//     → {device_code, user_code: "MOCK-CODE", verification_uri: "<이 서버>/login/device", expires_in: 900, interval: 1}
//     발급한 코드가 어떻게 끝날지는 직전에 POST /mock/device/next 로 정한 값(없으면 CodeOK)을 따른다.
//     client_id 가 ClientDisabled 면 {"error":"device_flow_disabled"}.
//   - POST /mock/device/next (JSON {"result": <아래 값>}) — 다음에 발급할 기기 코드의 결과를 정한다(테스트 제어용, GitHub 에는 없다)
//     · CodeOK → 바로 TokenOK · CodeUser2 → 바로 TokenUser2
//     · CodePending → authorization_pending 2번 뒤 TokenOK · CodeSlowDown → slow_down(interval 10) 1번 뒤 TokenOK
//     · CodeDenied → access_denied · CodeExpired → expired_token · CodeGitHubDown → HTTP 500
//     · CodeBadUser → 토큰은 주지만 /user 가 401
//   - POST /login/oauth/access_token (form: client_id, device_code, grant_type=urn:ietf:params:oauth:grant-type:device_code)
//     · 발급한 적 없거나 이미 토큰을 받은 device_code → expired_token (1회용)
//   - GET  /user (Authorization: Bearer|token <access token>)
//     · TokenOK → {id: 583231, login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4"}
//     · TokenUser2 → {id: 480938, login: "hubot", avatar_url: null}
//     · 그 외 → 401
//   - E2E 용 조직·저장소·이슈 목록은 repos.go
package githubmock

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
)

// POST /mock/device/next 의 result 값.
const (
	CodeOK         = "mock-code-ok"
	CodeUser2      = "mock-code-user2"
	CodePending    = "mock-code-pending"
	CodeSlowDown   = "mock-code-slow"
	CodeDenied     = "mock-code-denied"
	CodeExpired    = "mock-code-expired"
	CodeGitHubDown = "mock-code-5xx"
	// CodeBadUser 는 승인은 되지만 받은 토큰으로 /user 를 부르면 401 이 나는 경우다
	CodeBadUser = "mock-code-bad-user"

	TokenOK    = "gho_mock_token"
	TokenUser2 = "gho_mock_token2"

	// ClientDisabled 는 Device Flow 를 켜지 않은 OAuth App 의 client_id 다
	ClientDisabled = "mock-client-device-disabled"

	UserCode        = "MOCK-CODE"
	DeviceGrantType = "urn:ietf:params:oauth:grant-type:device_code"
)

var users = map[string]map[string]any{
	TokenOK:    {"id": 583231, "login": "octocat", "avatar_url": "https://avatars.githubusercontent.com/u/583231?v=4"},
	TokenUser2: {"id": 480938, "login": "hubot", "avatar_url": nil},
}

// device 는 발급한 기기 코드의 남은 진행이다.
type device struct {
	result string
	// polls 는 지금까지 토큰을 확인한 횟수다
	polls int
}

type mock struct {
	mu sync.Mutex
	// next 는 다음에 발급할 기기 코드의 결과(한 번 쓰면 비운다)
	next    string
	devices map[string]*device
}

// NewHandler 는 GitHub mock http.Handler 를 만든다. 핸들러마다 발급 코드 상태를 따로 가진다.
func NewHandler() http.Handler {
	m := &mock{devices: map[string]*device{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /login/device/code", m.deviceCode)
	mux.HandleFunc("POST /mock/device/next", m.setNext)
	mux.HandleFunc("POST /login/oauth/access_token", m.accessToken)
	mux.HandleFunc("GET /user", m.user)
	registerRepoRoutes(mux)
	return mux
}

func (m *mock) setNext(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Result string `json:"result"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	m.mu.Lock()
	m.next = body.Result
	m.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (m *mock) deviceCode(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	if r.PostFormValue("client_id") == "" {
		writeJSON(w, http.StatusOK, map[string]any{"error": "incorrect_client_credentials"})
		return
	}
	if r.PostFormValue("client_id") == ClientDisabled {
		writeJSON(w, http.StatusOK, map[string]any{"error": "device_flow_disabled"})
		return
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	code := "mock-device-" + hex.EncodeToString(b)
	m.mu.Lock()
	result := m.next
	m.next = ""
	if result == "" {
		result = CodeOK
	}
	m.devices[code] = &device{result: result}
	m.mu.Unlock()

	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"device_code":      code,
		"user_code":        UserCode,
		"verification_uri": scheme + "://" + r.Host + "/login/device",
		"expires_in":       900,
		"interval":         1,
	})
}

func (m *mock) accessToken(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	if r.PostFormValue("grant_type") != DeviceGrantType {
		writeJSON(w, http.StatusOK, map[string]any{"error": "unsupported_grant_type"})
		return
	}
	code := r.PostFormValue("device_code")

	m.mu.Lock()
	d, ok := m.devices[code]
	result, polls := "", 0
	if ok {
		d.polls++
		result, polls = d.result, d.polls
	}
	m.mu.Unlock()

	fail := func(errCode string, extra map[string]any) {
		body := map[string]any{"error": errCode}
		for k, v := range extra {
			body[k] = v
		}
		writeJSON(w, http.StatusOK, body)
	}
	token := ""
	switch {
	case !ok:
		fail("expired_token", nil)
		return
	case result == CodeOK:
		token = TokenOK
	case result == CodeUser2:
		token = TokenUser2
	case result == CodeBadUser:
		token = "gho_mock_unknown"
	case result == CodePending:
		if polls <= 2 {
			fail("authorization_pending", nil)
			return
		}
		token = TokenOK
	case result == CodeSlowDown:
		if polls <= 1 {
			fail("slow_down", map[string]any{"interval": 10})
			return
		}
		token = TokenOK
	case result == CodeDenied:
		fail("access_denied", nil)
		return
	case result == CodeGitHubDown:
		http.Error(w, "mock github down", http.StatusInternalServerError)
		return
	default:
		fail("expired_token", nil)
		return
	}
	// 토큰은 한 번만 내준다
	m.mu.Lock()
	delete(m.devices, code)
	m.mu.Unlock()
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
