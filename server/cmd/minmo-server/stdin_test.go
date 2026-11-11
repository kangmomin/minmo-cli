package main

import (
	"context"
	"io"
	"testing"
	"time"
)

func TestStopOnCloseCancelsWhenReaderCloses(t *testing.T) {
	r, w := io.Pipe()
	ctx, cancel := stopOnClose(context.Background(), r)
	defer cancel()

	if _, err := w.Write([]byte("ignored\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
		t.Fatal("입력이 오는 동안에는 취소되면 안 된다")
	case <-time.After(50 * time.Millisecond):
	}

	_ = w.Close()
	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("stdin 이 닫혔는데 취소되지 않았다")
	}
}

func TestStopOnCloseFollowsParent(t *testing.T) {
	r, w := io.Pipe()
	defer w.Close()
	parent, cancelParent := context.WithCancel(context.Background())
	ctx, cancel := stopOnClose(parent, r)
	defer cancel()

	cancelParent()
	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("부모 ctx 취소가 전달되지 않았다")
	}
}
