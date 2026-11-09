// Package db 는 SQLite 연결을 열고 마이그레이션(embed iofs)을 적용한다.
package db

import (
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "modernc.org/sqlite" // database/sql 드라이버 "sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Open 은 path 의 SQLite 파일을 열고 마이그레이션을 적용한 뒤 반환한다.
//
// DSN 은 `file:` 접두 없이 경로 + `_pragma` 쿼리로 구성한다 — modernc 드라이버가 쿼리를 떼어 pragma 로
// 적용하므로 Windows 경로(`C:\…`)를 URI 이스케이프 없이 그대로 쓸 수 있다.
func Open(path string) (*sql.DB, error) {
	dsn := path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	return openAndMigrate(dsn, 0)
}

// OpenMemory 는 고유 이름의 shared-cache 인메모리 DB 를 열고 마이그레이션을 적용한 뒤 반환한다.
// 연결이 모두 닫히면 인메모리 DB 가 사라지므로 연결 1개로 고정한다.
func OpenMemory() (*sql.DB, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	dsn := "file:mem_" + hex.EncodeToString(b) + "?mode=memory&cache=shared&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"
	return openAndMigrate(dsn, 1)
}

func openAndMigrate(dsn string, maxOpen int) (*sql.DB, error) {
	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("DB 열기 실패: %w", err)
	}
	if maxOpen > 0 {
		conn.SetMaxOpenConns(maxOpen)
	}
	if err := migrateUp(conn); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
}

// migrateUp 은 embed 된 migrations 를 최신까지 적용한다.
// migrate.Close() 는 conn 까지 닫으므로 호출하지 않는다(소스는 embed FS 라 해제할 자원 없음).
func migrateUp(conn *sql.DB) error {
	src, err := iofs.New(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("마이그레이션 소스 로드 실패: %w", err)
	}
	drv, err := sqlite.WithInstance(conn, &sqlite.Config{})
	if err != nil {
		return fmt.Errorf("마이그레이션 드라이버 초기화 실패: %w", err)
	}
	m, err := migrate.NewWithInstance("iofs", src, "sqlite", drv)
	if err != nil {
		return fmt.Errorf("마이그레이션 준비 실패: %w", err)
	}
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("마이그레이션 적용 실패: %w", err)
	}
	return nil
}
