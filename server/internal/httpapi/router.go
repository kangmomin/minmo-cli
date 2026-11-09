// Package httpapi 는 minmo 서버의 HTTP API(Integration Contract v2.4)를 제공한다.
//
// Phase 6.1 Red 스텁: 시그니처만 고정한다. 실제 구현은 Phase 6.2.
package httpapi

import (
	"database/sql"
	"net/http"
	"time"
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

// NewHandler 는 라우터와 미들웨어 체인을 조립한다. now 는 시각 주입(테스트용).
func NewHandler(cfg Config, db *sql.DB, now func() time.Time) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not implemented", http.StatusNotImplemented)
	})
}
