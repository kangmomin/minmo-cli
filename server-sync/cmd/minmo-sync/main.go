// Command minmo-sync 는 설정 페어링 동기화 서버다. 설정은 env 로만 받는다.
//
//	MINMO_SYNC_LISTEN        기본 127.0.0.1:8788
//	MINMO_SYNC_DB_PATH       기본 ./minmo-sync.db
//	MINMO_SYNC_CORS_ORIGINS  쉼표 구분(기본: 데스크탑 앱 origin)
//	MINMO_ALLOW_NON_LOOPBACK 비loopback 바인딩 시 1 필요
package main

import (
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/kangmomin/minmo-cli/server-sync/internal/syncapi"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	if err := run(); err != nil {
		slog.Error("minmo-sync 종료", "err", err)
		os.Exit(1)
	}
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func run() error {
	listen := env("MINMO_SYNC_LISTEN", "127.0.0.1:8788")
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		return err
	}
	// 페어링 서버를 실수로 외부에 노출하지 않도록 기존 server 와 같은 규약을 쓴다
	if ip := net.ParseIP(host); (ip == nil || !ip.IsLoopback()) && host != "localhost" && os.Getenv("MINMO_ALLOW_NON_LOOPBACK") != "1" {
		return errors.New("비loopback 바인딩은 MINMO_ALLOW_NON_LOOPBACK=1 이 필요합니다")
	}
	store, err := syncapi.Open(env("MINMO_SYNC_DB_PATH", "./minmo-sync.db"))
	if err != nil {
		return err
	}
	defer store.Close()

	origins := strings.Split(env("MINMO_SYNC_CORS_ORIGINS", "http://localhost:1420,tauri://localhost,http://tauri.localhost,https://tauri.localhost"), ",")
	srv := &http.Server{
		Addr:              listen,
		Handler:           syncapi.NewHandler(store, time.Now, origins),
		ReadHeaderTimeout: 10 * time.Second,
	}
	slog.Info("minmo-sync 시작", "listen", listen)
	return srv.ListenAndServe()
}
