// Package db 는 SQLite 연결을 열고 마이그레이션(embed iofs)을 적용한다.
//
// Phase 6.1 Red 스텁: 시그니처만 고정한다. 실제 구현은 Phase 6.2.
package db

import (
	"database/sql"
	"errors"

	// 6.2 구현이 사용할 드라이버·마이그레이션 의존성을 go.mod 에 고정하기 위한 blank import.
	_ "github.com/golang-migrate/migrate/v4/database/sqlite"
	_ "github.com/golang-migrate/migrate/v4/source/iofs"
	_ "modernc.org/sqlite"
)

var errNotImplemented = errors.New("not implemented")

// Open 은 path 의 SQLite 파일을 열고 마이그레이션을 적용한 뒤 반환한다.
func Open(path string) (*sql.DB, error) {
	return nil, errNotImplemented
}

// OpenMemory 는 고유 이름의 shared-cache 인메모리 DB 를 열고 마이그레이션을 적용한 뒤 반환한다.
func OpenMemory() (*sql.DB, error) {
	return nil, errNotImplemented
}
