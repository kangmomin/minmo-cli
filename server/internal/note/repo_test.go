package note_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/kangmomin/minmo-cli/server/internal/db"
	"github.com/kangmomin/minmo-cli/server/internal/note"
)

const testUserID = "usr_00000000-0000-4000-8000-000000000001"

var (
	t0  = time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	key = note.Key{UserID: testUserID, Owner: "acme", Repo: "widgets", IssueKey: "42"}
)

func openRepo(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := db.OpenMemory()
	if err != nil {
		t.Fatalf("db.OpenMemory: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_, err = conn.Exec(`INSERT INTO users(id, github_id, login, avatar_url, access_token_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		testUserID, 583231, "octocat", nil, []byte{0}, int64(0))
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return conn
}

func ms(n *int64) any {
	if n == nil {
		return nil
	}
	return *n
}

func mustPut(t *testing.T, conn *sql.DB, body string, base note.Base, now time.Time) note.Note {
	t.Helper()
	n, err := note.Put(context.Background(), conn, key, body, base, now)
	if err != nil {
		t.Fatalf("Put(%q, %+v): %v", body, base, err)
	}
	if n.Body != body || n.UpdatedAt == nil {
		t.Fatalf("Put result %+v (updatedAt %v)", n, ms(n.UpdatedAt))
	}
	return n
}

func expectConflict(t *testing.T, err error, wantBody string, wantAt *int64) {
	t.Helper()
	var c *note.ErrConflict
	if !errors.As(err, &c) {
		t.Fatalf("err = %v, want *ErrConflict", err)
	}
	if c.Current.Body != wantBody {
		t.Errorf("conflict current body %q, want %q", c.Current.Body, wantBody)
	}
	if (wantAt == nil) != (c.Current.UpdatedAt == nil) || (wantAt != nil && *wantAt != *c.Current.UpdatedAt) {
		t.Errorf("conflict current updatedAt %v, want %v", ms(c.Current.UpdatedAt), ms(wantAt))
	}
}

// CT-13: 행 없음 → body "" · updatedAt nil
func TestGet_Empty_CT13(t *testing.T) {
	conn := openRepo(t)
	n, err := note.Get(context.Background(), conn, key)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if n.Body != "" || n.UpdatedAt != nil {
		t.Errorf("Get empty = %+v (updatedAt %v)", n, ms(n.UpdatedAt))
	}
}

// CT-14: baseUpdatedAt 생략 → 무조건 저장, updatedAt = now(ms), 이어 Get 동일
func TestPut_Omitted_CT14(t *testing.T) {
	conn := openRepo(t)
	n := mustPut(t, conn, "x", note.Base{Kind: note.BaseOmitted}, t0)
	if *n.UpdatedAt != t0.UnixMilli() {
		t.Errorf("updatedAt %d, want %d", *n.UpdatedAt, t0.UnixMilli())
	}
	got, err := note.Get(context.Background(), conn, key)
	if err != nil || got.Body != "x" || got.UpdatedAt == nil || *got.UpdatedAt != *n.UpdatedAt {
		t.Errorf("Get after Put = %+v / %v (err %v)", got, ms(got.UpdatedAt), err)
	}
	// 생략은 행이 있어도 덮어쓴다
	n2 := mustPut(t, conn, "y", note.Base{}, t0.Add(time.Second))
	if *n2.UpdatedAt != t0.Add(time.Second).UnixMilli() {
		t.Errorf("overwrite updatedAt %d", *n2.UpdatedAt)
	}
}

// CT-15 / EC-07: 문자열 base 가 저장값과 다르면 409(Current = 서버 현재값, 행 불변), 같으면 저장
func TestPut_BaseValue_CT15(t *testing.T) {
	conn := openRepo(t)
	first := mustPut(t, conn, "x", note.Base{}, t0)
	second := mustPut(t, conn, "y", note.Base{}, t0.Add(time.Second))

	_, err := note.Put(context.Background(), conn, key, "z", note.Base{Kind: note.BaseValue, Ms: *first.UpdatedAt}, t0.Add(2*time.Second))
	expectConflict(t, err, "y", second.UpdatedAt)
	if got, _ := note.Get(context.Background(), conn, key); got.Body != "y" {
		t.Errorf("row changed after conflict: %q", got.Body)
	}

	third := mustPut(t, conn, "z", note.Base{Kind: note.BaseValue, Ms: *second.UpdatedAt}, t0.Add(3*time.Second))
	if *third.UpdatedAt != t0.Add(3*time.Second).UnixMilli() {
		t.Errorf("updatedAt %d", *third.UpdatedAt)
	}
}

// CT-15: 행이 없는데 문자열 base → 409, Current body "" · updatedAt nil
func TestPut_BaseValueNoRow_CT15(t *testing.T) {
	conn := openRepo(t)
	_, err := note.Put(context.Background(), conn, key, "z", note.Base{Kind: note.BaseValue, Ms: t0.UnixMilli()}, t0)
	expectConflict(t, err, "", nil)
}

// CT-30: base null → 행 없으면 저장, 행 있으면 409(Current = 서버 값)
func TestPut_BaseNull_CT30(t *testing.T) {
	conn := openRepo(t)
	a := mustPut(t, conn, "a", note.Base{Kind: note.BaseNull}, t0)
	_, err := note.Put(context.Background(), conn, key, "b", note.Base{Kind: note.BaseNull}, t0.Add(time.Second))
	expectConflict(t, err, "a", a.UpdatedAt)
}

// CT-31: 같은 밀리초 연속 쓰기 → +1ms, 이전 값으로 PUT → 409. 시계가 뒤로 가도 단조 증가(max(now, prev+1))
func TestPut_MonotonicUpdatedAt_CT31(t *testing.T) {
	conn := openRepo(t)
	n1 := mustPut(t, conn, "1", note.Base{}, t0)
	n2 := mustPut(t, conn, "2", note.Base{}, t0)
	if *n2.UpdatedAt != *n1.UpdatedAt+1 {
		t.Errorf("same-ms updatedAt %d, want %d", *n2.UpdatedAt, *n1.UpdatedAt+1)
	}
	_, err := note.Put(context.Background(), conn, key, "3", note.Base{Kind: note.BaseValue, Ms: *n1.UpdatedAt}, t0)
	expectConflict(t, err, "2", n2.UpdatedAt)

	n3 := mustPut(t, conn, "3", note.Base{Kind: note.BaseValue, Ms: *n2.UpdatedAt}, t0) // 같은 ms, 일치 base
	if *n3.UpdatedAt != *n2.UpdatedAt+1 {
		t.Errorf("same-ms with base updatedAt %d, want %d", *n3.UpdatedAt, *n2.UpdatedAt+1)
	}
	n4 := mustPut(t, conn, "4", note.Base{}, t0.Add(-time.Hour)) // 시계 역행
	if *n4.UpdatedAt != *n3.UpdatedAt+1 {
		t.Errorf("clock skew updatedAt %d, want %d", *n4.UpdatedAt, *n3.UpdatedAt+1)
	}
}
