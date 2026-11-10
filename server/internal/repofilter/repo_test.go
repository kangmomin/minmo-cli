package repofilter_test

import (
	"context"
	"database/sql"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/kangmomin/minmo-cli/server/internal/db"
	"github.com/kangmomin/minmo-cli/server/internal/repofilter"
)

const uid = "usr_00000000-0000-4000-8000-000000000001"

var t0 = time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

func openRepo(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := db.OpenMemory()
	if err != nil {
		t.Fatalf("db.OpenMemory: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_, err = conn.Exec(`INSERT INTO users(id, github_id, login, avatar_url, access_token_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		uid, 1, "octocat", nil, []byte{0}, int64(0))
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return conn
}

func TestNormalize(t *testing.T) {
	got, ok := repofilter.Normalize([]string{" Acme/Widgets ", "acme/*", "acme/widgets", "Me/repo.x"})
	if !ok || !reflect.DeepEqual(got, []string{"acme/*", "acme/widgets", "me/repo.x"}) {
		t.Errorf("Normalize = %v, %v", got, ok)
	}
	for _, bad := range []string{"acme", "acme/", "/x", "a/b/c", "a/..", "../x", "a b/c", "*/x", "a/*x"} {
		if _, ok := repofilter.Normalize([]string{bad}); ok {
			t.Errorf("%q 는 거부돼야 한다", bad)
		}
	}
	if _, ok := repofilter.Normalize(make([]string, repofilter.MaxEntries+1)); ok {
		t.Error("상한 초과는 거부")
	}
	if got, ok := repofilter.Normalize([]string{}); !ok || got == nil || len(got) != 0 {
		t.Errorf("빈 목록은 그대로(전부 숨김): %v %v", got, ok)
	}
}

func TestGetPut(t *testing.T) {
	ctx := context.Background()
	conn := openRepo(t)

	f, err := repofilter.Get(ctx, conn, uid)
	if err != nil || f.Repos != nil || f.UpdatedAt != nil {
		t.Fatalf("행 없음 = 전체 표시: %+v %v", f, err)
	}
	// baseUpdatedAt null: 처음 저장
	f, err = repofilter.Put(ctx, conn, uid, []string{"acme/widgets"}, repofilter.Base{Kind: repofilter.BaseNull}, t0)
	if err != nil || !reflect.DeepEqual(f.Repos, []string{"acme/widgets"}) || *f.UpdatedAt != t0.UnixMilli() {
		t.Fatalf("첫 저장: %+v %v", f, err)
	}
	// 이미 있으면 null 은 충돌
	if _, err := repofilter.Put(ctx, conn, uid, nil, repofilter.Base{Kind: repofilter.BaseNull}, t0); !errors.Is(err, repofilter.ErrConflict) {
		t.Errorf("null 충돌: %v", err)
	}
	// 오래된 base 는 충돌, 맞는 base 는 저장(같은 ms 여도 단조 증가)
	if _, err := repofilter.Put(ctx, conn, uid, nil, repofilter.Base{Kind: repofilter.BaseValue, Ms: 1}, t0); !errors.Is(err, repofilter.ErrConflict) {
		t.Errorf("오래된 base: %v", err)
	}
	f, err = repofilter.Put(ctx, conn, uid, []string{}, repofilter.Base{Kind: repofilter.BaseValue, Ms: t0.UnixMilli()}, t0)
	if err != nil || f.Repos == nil || len(f.Repos) != 0 || *f.UpdatedAt != t0.UnixMilli()+1 {
		t.Fatalf("빈 목록 저장: %+v %v", f, err)
	}
	// 생략: 무조건 덮어쓰기, nil 은 전체 표시로 되돌림
	f, err = repofilter.Put(ctx, conn, uid, nil, repofilter.Base{}, t0.Add(time.Second))
	if err != nil || f.Repos != nil {
		t.Fatalf("전체 표시로: %+v %v", f, err)
	}
	g, _ := repofilter.Get(ctx, conn, uid)
	if g.Repos != nil || *g.UpdatedAt != *f.UpdatedAt {
		t.Errorf("Get 이 저장값과 다르다: %+v", g)
	}
}
