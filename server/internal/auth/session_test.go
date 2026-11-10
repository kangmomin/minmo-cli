package auth_test

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"regexp"
	"testing"
	"time"

	"github.com/kangmomin/minmo-cli/server/internal/auth"
	"github.com/kangmomin/minmo-cli/server/internal/db"
)

var reToken = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

const testUserID = "usr_00000000-0000-4000-8000-000000000001"

func openWithUser(t *testing.T) *sql.DB {
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

// CT-02(<token> 형식): 32B base64url 43자 · 매 호출 고유
func TestNewToken_CT02(t *testing.T) {
	a, err := auth.NewToken()
	if err != nil {
		t.Fatalf("NewToken: %v", err)
	}
	b, _ := auth.NewToken()
	if !reToken.MatchString(a) || !reToken.MatchString(b) {
		t.Errorf("token format: %q %q", a, b)
	}
	if a == b {
		t.Errorf("tokens must differ")
	}
}

// F-01(서버는 SHA-256 hex 만 저장): Hash = lowercase hex(sha256(token))
func TestHash_F01(t *testing.T) {
	tok := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
	sum := sha256.Sum256([]byte(tok))
	if got := auth.Hash(tok); got != hex.EncodeToString(sum[:]) {
		t.Errorf("Hash = %q", got)
	}
}

// CT-24: 만료 30일 — 29일 뒤 유효, 31일 뒤 ErrInvalidSession
func TestSession_Expiry_CT24(t *testing.T) {
	conn := openWithUser(t)
	ctx := context.Background()
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	tok, err := auth.Create(ctx, conn, testUserID, now)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !reToken.MatchString(tok) {
		t.Errorf("token format %q", tok)
	}
	if uid, err := auth.Lookup(ctx, conn, tok, now.Add(29*24*time.Hour)); err != nil || uid != testUserID {
		t.Errorf("29d Lookup = (%q, %v), want (%s, nil)", uid, err, testUserID)
	}
	if _, err := auth.Lookup(ctx, conn, tok, now.Add(31*24*time.Hour)); !errors.Is(err, auth.ErrInvalidSession) {
		t.Errorf("31d Lookup err = %v, want ErrInvalidSession", err)
	}
}

// CT-04: 위조 토큰 → ErrInvalidSession / F-01: DB 에는 원문이 아닌 해시만 저장
func TestSession_ForgedAndHashedStorage_CT04(t *testing.T) {
	conn := openWithUser(t)
	ctx := context.Background()
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	tok, err := auth.Create(ctx, conn, testUserID, now)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	var stored string
	if err := conn.QueryRow(`SELECT token_hash FROM sessions`).Scan(&stored); err != nil {
		t.Fatalf("select token_hash: %v", err)
	}
	sum := sha256.Sum256([]byte(tok))
	if stored != hex.EncodeToString(sum[:]) {
		t.Errorf("stored token_hash %q is not sha256 hex of token", stored)
	}
	if _, err := auth.Lookup(ctx, conn, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", now); !errors.Is(err, auth.ErrInvalidSession) {
		t.Errorf("forged Lookup err = %v, want ErrInvalidSession", err)
	}
	if _, err := auth.Lookup(ctx, conn, stored, now); !errors.Is(err, auth.ErrInvalidSession) {
		t.Errorf("hash used as token must fail, err = %v", err)
	}
}

// CT-06: 삭제 후 같은 토큰은 ErrInvalidSession
func TestSession_Delete_CT06(t *testing.T) {
	conn := openWithUser(t)
	ctx := context.Background()
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	tok, err := auth.Create(ctx, conn, testUserID, now)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := auth.Delete(ctx, conn, tok); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := auth.Lookup(ctx, conn, tok, now); !errors.Is(err, auth.ErrInvalidSession) {
		t.Errorf("Lookup after Delete err = %v, want ErrInvalidSession", err)
	}
	if err := auth.Delete(ctx, conn, tok); !errors.Is(err, auth.ErrInvalidSession) {
		t.Errorf("second Delete err = %v, want ErrInvalidSession", err)
	}
}

// 원격 CLI 세션: 종류·이름 저장, 목록(만료 제외·최근 순), last_used_at 1분 단위 갱신, 본인 세션만 폐기
func TestSessionKindListRevoke(t *testing.T) {
	ctx := context.Background()
	conn := openWithUser(t)
	t0 := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

	desk, _ := auth.Create(ctx, conn, testUserID, t0)
	cli, err := auth.CreateKind(ctx, conn, testUserID, auth.KindCLI, "devbox", t0.Add(time.Second))
	if err != nil {
		t.Fatalf("CreateKind: %v", err)
	}
	s, err := auth.LookupSession(ctx, conn, cli, t0.Add(2*time.Second))
	if err != nil || s.Kind != auth.KindCLI || s.Label == nil || *s.Label != "devbox" || s.LastUsedAt == nil {
		t.Fatalf("LookupSession = %+v %v", s, err)
	}
	first := *s.LastUsedAt
	// 1분 안의 재사용은 갱신하지 않는다
	s, _ = auth.LookupSession(ctx, conn, cli, t0.Add(30*time.Second))
	if *s.LastUsedAt != first {
		t.Errorf("1분 안에는 그대로여야 한다: %d → %d", first, *s.LastUsedAt)
	}
	s, _ = auth.LookupSession(ctx, conn, cli, t0.Add(2*time.Minute))
	if *s.LastUsedAt == first {
		t.Error("1분이 지나면 갱신")
	}

	list, err := auth.List(ctx, conn, testUserID, t0.Add(3*time.Minute))
	if err != nil || len(list) != 2 || list[0].Kind != auth.KindCLI || list[1].Kind != auth.KindDesktop || list[1].Label != nil {
		t.Fatalf("List = %+v %v", list, err)
	}
	if l, _ := auth.List(ctx, conn, testUserID, t0.Add(auth.SessionTTL+time.Hour)); len(l) != 0 {
		t.Errorf("만료된 세션은 목록에서 뺀다: %+v", l)
	}

	if err := auth.DeleteByID(ctx, conn, "usr_other", list[0].ID); !errors.Is(err, auth.ErrInvalidSession) {
		t.Errorf("다른 사용자 폐기: %v", err)
	}
	if err := auth.DeleteByID(ctx, conn, testUserID, list[0].ID); err != nil {
		t.Fatalf("DeleteByID: %v", err)
	}
	if _, err := auth.Lookup(ctx, conn, cli, t0.Add(4*time.Minute)); !errors.Is(err, auth.ErrInvalidSession) {
		t.Errorf("폐기한 세션은 401: %v", err)
	}
	if _, err := auth.Lookup(ctx, conn, desk, t0.Add(4*time.Minute)); err != nil {
		t.Errorf("데스크탑 세션은 유지: %v", err)
	}
}
