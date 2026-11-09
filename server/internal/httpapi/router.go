// Package httpapi 는 minmo 서버의 HTTP API(Integration Contract v2.4)를 제공한다.
package httpapi

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/kangmomin/minmo-cli/server/internal/auth"
	"github.com/kangmomin/minmo-cli/server/internal/settings"
)

// Config 는 서버 env 를 해석한 값이다. contract_test.go 가 이 필드 집합에 의존한다.
type Config struct {
	PublicURL          string
	DeepLink           string
	GitHubOAuthBase    string
	GitHubAPIBase      string
	GitHubClientID     string
	GitHubClientSecret string
	TokenKey           []byte
	CORSOrigins        []string
	HTTPClient         *http.Client
}

// defaultGitHubTimeout 은 cfg.HTTPClient 가 없을 때 GitHub 호출 제한 시간이다.
const defaultGitHubTimeout = 15 * time.Second

type api struct {
	cfg    Config
	db     *sql.DB
	now    func() time.Time
	states *auth.StateStore
	gh     *auth.GitHubClient
}

// NewHandler 는 라우터와 미들웨어 체인을 조립한다. now 는 시각 주입(테스트용, nil 이면 time.Now).
// 체인: recover → log → no-store → CORS → mux(404/405 JSON). 인증은 라우트별(authed)로 적용해
// 미등록 경로·메서드는 토큰 없이도 404/405 를 받는다.
func NewHandler(cfg Config, db *sql.DB, now func() time.Time) http.Handler {
	if now == nil {
		now = time.Now
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultGitHubTimeout}
	}
	a := &api{
		cfg:    cfg,
		db:     db,
		now:    now,
		states: auth.NewStateStore(now),
		gh: &auth.GitHubClient{
			OAuthBase:    strings.TrimRight(cfg.GitHubOAuthBase, "/"),
			APIBase:      strings.TrimRight(cfg.GitHubAPIBase, "/"),
			ClientID:     cfg.GitHubClientID,
			ClientSecret: cfg.GitHubClientSecret,
			RedirectURI:  strings.TrimRight(cfg.PublicURL, "/") + "/auth/github/callback",
			HTTP:         httpClient,
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.healthz)

	mux.HandleFunc("POST /auth/github/start", a.startLogin)
	mux.HandleFunc("GET /auth/github/callback", a.callback)
	mux.HandleFunc("GET /me", a.authed(a.me))
	mux.HandleFunc("GET /me/github-token", a.authed(a.githubToken))
	mux.HandleFunc("DELETE /auth/session", a.authed(a.logout))

	mux.HandleFunc("GET /settings", a.authed(a.getSettings(settings.ScopeGlobal)))
	mux.HandleFunc("PUT /settings", a.authed(a.putSettings(settings.ScopeGlobal)))
	mux.HandleFunc("GET /orgs/{owner}/settings", a.authed(a.getSettings(settings.ScopeOrg)))
	mux.HandleFunc("PUT /orgs/{owner}/settings", a.authed(a.putSettings(settings.ScopeOrg)))
	mux.HandleFunc("GET /projects/{owner}/{repo}/settings", a.authed(a.getSettings(settings.ScopeProject)))
	mux.HandleFunc("PUT /projects/{owner}/{repo}/settings", a.authed(a.putSettings(settings.ScopeProject)))
	mux.HandleFunc("GET /projects/{owner}/{repo}/settings/effective", a.authed(a.getEffective))

	mux.HandleFunc("GET /projects/{owner}/{repo}/issues/{key}/notes", a.authed(a.getNotes))
	mux.HandleFunc("PUT /projects/{owner}/{repo}/issues/{key}/notes", a.authed(a.putNotes))

	var h http.Handler = jsonFallback(mux)
	h = cors(cfg.CORSOrigins, h)
	h = noStore(h)
	h = logRequests(h)
	return recoverPanics(h)
}

// jsonFallback 은 ServeMux 의 기본 텍스트 404/405 를 계약 JSON(not_found/method_not_allowed)으로 바꾼다.
func jsonFallback(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h, pattern := mux.Handler(r); pattern == "" {
			cw := &captureWriter{header: http.Header{}}
			h.ServeHTTP(cw, r)
			if cw.status == http.StatusMethodNotAllowed {
				if allow := cw.header.Get("Allow"); allow != "" {
					w.Header().Set("Allow", allow)
				}
				writeError(w, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "")
				return
			}
			writeError(w, http.StatusNotFound, CodeNotFound, "")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (a *api) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
