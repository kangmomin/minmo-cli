// Package config 는 서버 env(Integration Contract v2.4 "서버 env" 표)를 읽고 검증한다.
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"strings"

	"github.com/kangmomin/minmo-cli/server/internal/httpapi"
)

// 계약 "서버 env" 기본값.
const (
	DefaultListen          = "127.0.0.1:8787"
	DefaultPublicURL       = "http://127.0.0.1:8787"
	DefaultDBPath          = "./minmo.db"
	DefaultGitHubOAuthBase = "https://github.com"
	DefaultGitHubAPIBase   = "https://api.github.com"
	// DefaultGitHubClientID 는 minmo 용 GitHub OAuth App(Device Flow 사용)의 Client ID 다.
	// 기기 코드 방식은 Secret 이 필요 없어, 공개 값인 Client ID 만 넣어 배포한다. 비어 있으면 로그인할 수 없다.
	DefaultGitHubClientID = ""
)

// DefaultCORSOrigins 는 MINMO_CORS_ORIGINS 미설정 시 허용 Origin(A-P04)이다.
var DefaultCORSOrigins = []string{"http://localhost:1420", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"}

// Config 는 프로세스 설정이다. API 는 httpapi.NewHandler 에 그대로 넘긴다.
type Config struct {
	Listen string
	DBPath string
	API    httpapi.Config
}

// OAuthConfigured 는 로그인(E1)이 동작할 수 있는지(Client ID 가 있는지) 여부다.
func (c Config) OAuthConfigured() bool {
	return c.API.GitHubClientID != ""
}

// Load 는 getenv(보통 os.Getenv)로 설정을 읽는다. MINMO_TOKEN_KEY 누락·형식 오류,
// MINMO_ALLOW_NON_LOOPBACK=1 없는 비loopback 바인딩은 오류(기동 실패)다.
func Load(getenv func(string) string) (Config, error) {
	get := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}

	cfg := Config{
		Listen: get("MINMO_LISTEN", DefaultListen),
		DBPath: get("MINMO_DB_PATH", DefaultDBPath),
		API: httpapi.Config{
			PublicURL:       strings.TrimRight(get("MINMO_PUBLIC_URL", DefaultPublicURL), "/"),
			GitHubOAuthBase: strings.TrimRight(get("MINMO_GITHUB_OAUTH_BASE", DefaultGitHubOAuthBase), "/"),
			GitHubAPIBase:   strings.TrimRight(get("MINMO_GITHUB_API_BASE", DefaultGitHubAPIBase), "/"),
			// 환경 변수는 테스트(githubmock)·직접 만든 OAuth App 으로 바꿔 쓸 때만 둔다
			GitHubClientID: get("MINMO_GITHUB_CLIENT_ID", DefaultGitHubClientID),
			CORSOrigins:    splitOrigins(get("MINMO_CORS_ORIGINS", "")),
		},
	}

	key, err := parseTokenKey(getenv("MINMO_TOKEN_KEY"))
	if err != nil {
		return Config{}, err
	}
	cfg.API.TokenKey = key

	if getenv("MINMO_ALLOW_NON_LOOPBACK") != "1" {
		loopback, err := isLoopback(cfg.Listen)
		if err != nil {
			return Config{}, err
		}
		if !loopback {
			return Config{}, fmt.Errorf("MINMO_LISTEN=%q 는 loopback 이 아닙니다. 외부 바인딩은 MINMO_ALLOW_NON_LOOPBACK=1 이 필요합니다", cfg.Listen)
		}
	}
	return cfg, nil
}

// parseTokenKey 는 base64(표준·URL-safe, 패딩 유무 무관) 32바이트 키를 해석한다.
// 계약은 "base64 32B"만 정한다 — 키 생성 도구 차이를 흡수하려고 4가지 인코딩을 모두 수용.
func parseTokenKey(v string) ([]byte, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil, errors.New("MINMO_TOKEN_KEY 가 필요합니다 (base64 32바이트 — README 의 생성 명령 참고)")
	}
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if key, err := enc.DecodeString(v); err == nil {
			if len(key) != 32 {
				return nil, fmt.Errorf("MINMO_TOKEN_KEY 는 32바이트여야 합니다 (현재 %d바이트)", len(key))
			}
			return key, nil
		}
	}
	return nil, errors.New("MINMO_TOKEN_KEY 가 올바른 base64 가 아닙니다")
}

func isLoopback(listen string) (bool, error) {
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		return false, fmt.Errorf("MINMO_LISTEN=%q 형식 오류: %w", listen, err)
	}
	// 호스트명 localhost 도 loopback 으로 본다(IP 리터럴만 검사하면 기본 사용 예가 거부됨)
	if strings.EqualFold(host, "localhost") {
		return true, nil
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback(), nil
}

func splitOrigins(v string) []string {
	if v == "" {
		return append([]string(nil), DefaultCORSOrigins...)
	}
	var out []string
	for _, o := range strings.Split(v, ",") {
		if o = strings.TrimSpace(o); o != "" {
			out = append(out, o)
		}
	}
	return out
}
