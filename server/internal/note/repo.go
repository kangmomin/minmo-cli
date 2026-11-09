// Package note 는 이슈별 메모(issue_notes) 저장소다. baseUpdatedAt 3분기를 분기별 단일 SQL 로 원자화한다.
//
// Phase 6.1 Red 스텁: 타입·시그니처만 고정한다. 실제 구현은 Phase 6.2.
package note

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

var errNotImplemented = errors.New("not implemented")

// Key 는 메모 행의 기본 키다. Owner/Repo 는 호출자가 소문자로 정규화해 넘긴다.
type Key struct {
	UserID   string
	Owner    string
	Repo     string
	IssueKey string
}

// Note 는 메모 현재값이다. 행이 없으면 Body "" · UpdatedAt nil.
type Note struct {
	Body      string
	UpdatedAt *int64 // epoch ms
}

// BaseKind 는 E14 baseUpdatedAt 의 3분기다. 0 값은 생략(무조건 덮어쓰기).
type BaseKind int

const (
	BaseOmitted BaseKind = iota // 생략 → 무조건 덮어쓰기
	BaseNull                    // null → 행이 없어야 함
	BaseValue                   // 문자열 → 저장된 updated_at 과 Ms 가 같아야 함
)

// Base 는 baseUpdatedAt 입력이다. Kind == BaseValue 일 때만 Ms 를 쓴다.
type Base struct {
	Kind BaseKind
	Ms   int64
}

// ErrConflict 는 409 conflict 이며 Current 는 서버 현재값(행 없으면 "" / nil)이다.
type ErrConflict struct {
	Current Note
}

func (e *ErrConflict) Error() string { return "note conflict" }

// Get 은 메모를 조회한다. 행이 없으면 Note{Body: "", UpdatedAt: nil}.
func Get(ctx context.Context, db *sql.DB, k Key) (Note, error) {
	return Note{}, errNotImplemented
}

// Put 은 base 분기에 따라 저장한다. 새 updated_at = max(now_ms, prev_ms+1).
// 충돌이면 *ErrConflict 를 반환한다.
func Put(ctx context.Context, db *sql.DB, k Key, body string, base Base, now time.Time) (Note, error) {
	return Note{}, errNotImplemented
}
