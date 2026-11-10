package db_test

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/kangmomin/minmo-cli/server/internal/db"
)

func openAt(t *testing.T, path string) *sql.DB {
	t.Helper()
	conn, err := db.Open(path)
	if err != nil {
		t.Fatalf("db.Open(%q): %v", path, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func pragma(t *testing.T, conn *sql.DB, name string) string {
	t.Helper()
	var v string
	if err := conn.QueryRow("PRAGMA " + name).Scan(&v); err != nil {
		t.Fatalf("PRAGMA %s: %v", name, err)
	}
	return v
}

func checkOpened(t *testing.T, conn *sql.DB) {
	t.Helper()
	if v := pragma(t, conn, "foreign_keys"); v != "1" {
		t.Errorf("foreign_keys = %q, want 1", v)
	}
	if v := pragma(t, conn, "journal_mode"); v != "wal" {
		t.Errorf("journal_mode = %q, want wal", v)
	}
	if v := pragma(t, conn, "busy_timeout"); v != "5000" {
		t.Errorf("busy_timeout = %q, want 5000", v)
	}
	for _, tbl := range []string{"users", "sessions", "settings", "issue_notes"} {
		var n int
		if err := conn.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", tbl).Scan(&n); err != nil || n != 1 {
			t.Errorf("테이블 %s 없음 (n=%d err=%v)", tbl, n, err)
		}
	}
}

func TestOpen_PragmasAndMigrations(t *testing.T) {
	checkOpened(t, openAt(t, filepath.Join(t.TempDir(), "x.db")))
}

// 공백 포함 하위 디렉터리(Windows 경로 포함)에서도 DSN 이 깨지지 않아야 한다.
func TestOpen_PathWithSpace(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "a b")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	checkOpened(t, openAt(t, filepath.Join(dir, "x.db")))
}
