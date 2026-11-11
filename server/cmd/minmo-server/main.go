// Command minmo-server 는 minmo API 서버다. 설정은 env(README "서버 env")로만 받는다.
// 보통은 데스크탑 앱이 사이드카로 띄우며 env 를 채워 준다(desktop/src-tauri/src/server.rs).
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kangmomin/minmo-cli/server/internal/config"
	"github.com/kangmomin/minmo-cli/server/internal/db"
	"github.com/kangmomin/minmo-cli/server/internal/httpapi"
)

const shutdownTimeout = 10 * time.Second

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	if err := run(); err != nil {
		slog.Error("minmo-server 종료", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	if !cfg.OAuthConfigured() {
		slog.Warn("MINMO_GITHUB_CLIENT_ID/SECRET 미설정 — POST /auth/github/start 는 503 github_oauth_not_configured")
	}

	conn, err := db.Open(cfg.DBPath)
	if err != nil {
		return err
	}
	defer conn.Close()

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           httpapi.NewHandler(cfg.API, conn, time.Now),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// 데스크탑 내장 실행: 부모(데스크탑)가 stdin 을 닫으면 정상 종료
	if os.Getenv("MINMO_STOP_ON_STDIN_CLOSE") == "1" {
		var cancel context.CancelFunc
		ctx, cancel = stopOnClose(ctx, os.Stdin)
		defer cancel()
	}

	// 포트 점유 등 bind 실패를 "listening" 로그 전에 오류로 돌려준다
	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return err
	}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("minmo-server listening", "addr", cfg.Listen, "publicUrl", cfg.API.PublicURL, "db", cfg.DBPath)
		errCh <- srv.Serve(ln)
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}

	slog.Info("minmo-server shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
