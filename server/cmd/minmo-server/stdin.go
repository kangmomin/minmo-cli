package main

import (
	"context"
	"io"
)

// stopOnClose 는 r(보통 stdin)이 닫히면(EOF·오류) 취소되는 ctx 를 돌려준다.
// 데스크탑이 띄운 서버는 Windows 에서 Ctrl+C·SIGTERM 을 받을 수 없어, 부모가 stdin 파이프를 닫는 것으로
// 종료를 알린다(부모가 비정상 종료해도 파이프가 닫힌다).
func stopOnClose(ctx context.Context, r io.Reader) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		_, _ = io.Copy(io.Discard, r)
		cancel()
	}()
	return ctx, cancel
}
