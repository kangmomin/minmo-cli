package config_test

import (
	"encoding/base64"
	"reflect"
	"strings"
	"testing"

	"github.com/kangmomin/minmo-cli/server/internal/config"
)

// loadWith 는 env 맵으로 Load 를 호출한다(맵에 없는 키는 빈 값).
func loadWith(env map[string]string) (config.Config, error) {
	return config.Load(func(k string) string { return env[k] })
}

func validKey() string { return base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32))) }

func TestLoad_Binding(t *testing.T) {
	cases := []struct {
		listen   string
		allowNon string
		wantErr  bool
	}{
		{"127.0.0.1:8787", "", false},
		{"localhost:8787", "", false},
		{"[::1]:8787", "", false},
		{"0.0.0.0:8787", "", true},
		{":8787", "", true},
		{"[::]:8787", "", true},
		{"0.0.0.0:8787", "1", false},
		{":8787", "1", false},
	}
	for _, c := range cases {
		cfg, err := loadWith(map[string]string{"MINMO_TOKEN_KEY": validKey(), "MINMO_LISTEN": c.listen, "MINMO_ALLOW_NON_LOOPBACK": c.allowNon})
		if (err != nil) != c.wantErr {
			t.Errorf("listen=%q allow=%q: err=%v, wantErr=%v", c.listen, c.allowNon, err, c.wantErr)
			continue
		}
		if err == nil && cfg.Listen != c.listen {
			t.Errorf("Listen = %q, want %q", cfg.Listen, c.listen)
		}
	}
}

func TestLoad_TokenKey(t *testing.T) {
	for name, v := range map[string]string{
		"빈 값":       "",
		"16B":       base64.StdEncoding.EncodeToString(make([]byte, 16)),
		"base64 아님": "!!!not-base64!!!",
	} {
		if _, err := loadWith(map[string]string{"MINMO_TOKEN_KEY": v}); err == nil {
			t.Errorf("%s: 오류 기대, nil", name)
		}
	}

	// 0xfb 0xff 반복 → std/url-safe 문자(+/ vs -_)가 실제로 달라지는 32B
	raw := []byte(strings.Repeat("\xfb\xff", 16))
	encs := map[string]*base64.Encoding{
		"std":     base64.StdEncoding,
		"std-raw": base64.RawStdEncoding,
		"url":     base64.URLEncoding,
		"url-raw": base64.RawURLEncoding,
	}
	for name, enc := range encs {
		cfg, err := loadWith(map[string]string{"MINMO_TOKEN_KEY": enc.EncodeToString(raw)})
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if len(cfg.API.TokenKey) != 32 || string(cfg.API.TokenKey) != string(raw) {
			t.Errorf("%s: 디코드 결과 %d바이트 불일치", name, len(cfg.API.TokenKey))
		}
	}
}

func TestLoad_CORSOrigins(t *testing.T) {
	base := map[string]string{"MINMO_TOKEN_KEY": validKey()}
	cfg, err := loadWith(base)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"http://localhost:1420", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"}
	if !reflect.DeepEqual(cfg.API.CORSOrigins, want) {
		t.Errorf("기본 CORS = %v, want %v", cfg.API.CORSOrigins, want)
	}

	base["MINMO_CORS_ORIGINS"] = " http://a.example , https://b.example,,  http://c.example "
	cfg, err = loadWith(base)
	if err != nil {
		t.Fatal(err)
	}
	want = []string{"http://a.example", "https://b.example", "http://c.example"}
	if !reflect.DeepEqual(cfg.API.CORSOrigins, want) {
		t.Errorf("CORS = %v, want %v", cfg.API.CORSOrigins, want)
	}
}

func TestLoad_Defaults(t *testing.T) {
	cfg, err := loadWith(map[string]string{"MINMO_TOKEN_KEY": validKey()})
	if err != nil {
		t.Fatal(err)
	}
	checks := []struct{ name, got, want string }{
		{"Listen", cfg.Listen, "127.0.0.1:8787"},
		{"PublicURL", cfg.API.PublicURL, "http://127.0.0.1:8787"},
		{"DeepLink", cfg.API.DeepLink, "minmo://auth"},
		{"GitHubOAuthBase", cfg.API.GitHubOAuthBase, "https://github.com"},
		{"GitHubAPIBase", cfg.API.GitHubAPIBase, "https://api.github.com"},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %q, want %q", c.name, c.got, c.want)
		}
	}
	if cfg.OAuthConfigured() {
		t.Error("client id/secret 미설정인데 OAuthConfigured=true")
	}
}
