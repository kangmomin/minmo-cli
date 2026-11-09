// Command githubmock 은 E2E 전용 GitHub OAuth/API mock 서버다(internal/githubmock 핸들러 재사용).
//
//	GITHUBMOCK_LISTEN (기본 127.0.0.1:8790)
//
// 서버는 MINMO_GITHUB_OAUTH_BASE / MINMO_GITHUB_API_BASE 를 이 주소(http://127.0.0.1:8790)로 지정해 쓴다.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kangmomin/minmo-cli/server/internal/githubmock"
)

const defaultListen = "127.0.0.1:8790"

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	if err := run(); err != nil {
		slog.Error("githubmock 종료", "err", err)
		os.Exit(1)
	}
}

func run() error {
	listen := os.Getenv("GITHUBMOCK_LISTEN")
	if listen == "" {
		listen = defaultListen
	}
	srv := &http.Server{
		Addr:              listen,
		Handler:           githubmock.NewHandler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		slog.Info("githubmock listening", "addr", listen,
			"codes", []string{githubmock.CodeOK, githubmock.CodeUser2, githubmock.CodeGitHubDown})
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
