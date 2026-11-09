// Package note 는 이슈별 메모(issue_notes) 저장소다. baseUpdatedAt 3분기를 분기별 단일 SQL 로 원자화한다.
package note

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

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
	var n Note
	var at int64
	err := db.QueryRowContext(ctx,
		`SELECT body, updated_at FROM issue_notes WHERE user_id = ? AND owner = ? AND repo = ? AND issue_key = ?`,
		k.UserID, k.Owner, k.Repo, k.IssueKey).Scan(&n.Body, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return Note{}, nil
	}
	if err != nil {
		return Note{}, fmt.Errorf("메모 조회 실패: %w", err)
	}
	n.UpdatedAt = &at
	return n, nil
}

// 각 분기는 SQL 한 문장으로 조건 검사와 쓰기를 원자화한다(계약 "baseUpdatedAt 의미").
// 새 updated_at = MAX(now_ms, prev_ms+1) — 같은 밀리초 내 연속 쓰기·시계 역행에도 단조 증가.
const (
	sqlPutOmitted = `
		INSERT INTO issue_notes (user_id, owner, repo, issue_key, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id, owner, repo, issue_key) DO UPDATE SET
			body = excluded.body,
			updated_at = MAX(excluded.updated_at, issue_notes.updated_at + 1)
		RETURNING body, updated_at`
	sqlPutNull = `
		INSERT INTO issue_notes (user_id, owner, repo, issue_key, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id, owner, repo, issue_key) DO NOTHING
		RETURNING body, updated_at`
	sqlPutValue = `
		UPDATE issue_notes SET body = ?, updated_at = MAX(?, updated_at + 1)
		WHERE user_id = ? AND owner = ? AND repo = ? AND issue_key = ? AND updated_at = ?
		RETURNING body, updated_at`
)

// Put 은 base 분기에 따라 저장한다. 새 updated_at = max(now_ms, prev_ms+1).
// 충돌이면 *ErrConflict 를 반환한다.
func Put(ctx context.Context, db *sql.DB, k Key, body string, base Base, now time.Time) (Note, error) {
	nowMs := now.UnixMilli()
	var row *sql.Row
	switch base.Kind {
	case BaseNull:
		row = db.QueryRowContext(ctx, sqlPutNull, k.UserID, k.Owner, k.Repo, k.IssueKey, body, nowMs)
	case BaseValue:
		row = db.QueryRowContext(ctx, sqlPutValue, body, nowMs, k.UserID, k.Owner, k.Repo, k.IssueKey, base.Ms)
	default:
		row = db.QueryRowContext(ctx, sqlPutOmitted, k.UserID, k.Owner, k.Repo, k.IssueKey, body, nowMs)
	}

	var n Note
	var at int64
	err := row.Scan(&n.Body, &at)
	if errors.Is(err, sql.ErrNoRows) {
		// 조건 불일치(영향 행 0) → 409. 현재값은 별도 조회(충돌 응답용 스냅샷).
		cur, gerr := Get(ctx, db, k)
		if gerr != nil {
			return Note{}, gerr
		}
		return Note{}, &ErrConflict{Current: cur}
	}
	if err != nil {
		return Note{}, fmt.Errorf("메모 저장 실패: %w", err)
	}
	n.UpdatedAt = &at
	return n, nil
}
