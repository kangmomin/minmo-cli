package auth

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
)

// SessionTTL 은 세션 만료 기간이다(A-P02).
const SessionTTL = 30 * 24 * time.Hour

// ErrInvalidSession 은 세션 없음·만료·위조·삭제를 모두 나타낸다(→ 401 unauthorized).
var ErrInvalidSession = errors.New("invalid session")

// NewToken 은 32B random base64url(패딩 없음, 43자) 불투명 세션 토큰을 만든다.
func NewToken() (string, error) {
	return randomURLToken(32)
}

// Hash 는 세션 토큰의 SHA-256 hex(소문자 64자)를 반환한다. DB 에는 이 값만 저장한다.
func Hash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// 세션 종류. 원격 CLI 는 데스크탑이 발급한 1회용 코드로 만든 세션이다.
const (
	KindDesktop = "desktop"
	KindCLI     = "cli"
)

// lastUsedGranularity 는 last_used_at 갱신 간격이다 — 요청마다 쓰지 않도록 1분 단위로 묶는다.
const lastUsedGranularity = time.Minute

// Session 은 저장된 세션 정보다(토큰 원문은 없음).
type Session struct {
	ID         string
	UserID     string
	Kind       string
	Label      *string
	CreatedAt  int64  // epoch ms
	LastUsedAt *int64 // epoch ms
}

// Create 는 userID 의 데스크탑 세션을 now 기준 만료 30일로 저장하고 원문 토큰을 반환한다.
func Create(ctx context.Context, db *sql.DB, userID string, now time.Time) (string, error) {
	return CreateKind(ctx, db, userID, KindDesktop, "", now)
}

// CreateKind 는 종류·이름을 붙여 세션을 만든다. label 이 비어 있으면 NULL 로 둔다.
func CreateKind(ctx context.Context, db *sql.DB, userID, kind, label string, now time.Time) (string, error) {
	token, err := NewToken()
	if err != nil {
		return "", fmt.Errorf("세션 토큰 생성 실패: %w", err)
	}
	var lbl any
	if label != "" {
		lbl = label
	}
	_, err = db.ExecContext(ctx,
		`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, kind, label) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		uuid.NewString(), userID, Hash(token), now.Add(SessionTTL).UnixMilli(), now.UnixMilli(), kind, lbl)
	if err != nil {
		return "", fmt.Errorf("세션 저장 실패: %w", err)
	}
	return token, nil
}

// Lookup 은 토큰의 세션을 찾아 userID 를 반환한다. 없음·만료(now 기준)는 ErrInvalidSession.
func Lookup(ctx context.Context, db *sql.DB, token string, now time.Time) (string, error) {
	s, err := LookupSession(ctx, db, token, now)
	return s.UserID, err
}

// LookupSession 은 토큰의 세션을 찾고 last_used_at 을 1분 단위로 갱신한다.
func LookupSession(ctx context.Context, db *sql.DB, token string, now time.Time) (Session, error) {
	var s Session
	var expiresAt int64
	var label sql.NullString
	var lastUsed sql.NullInt64
	err := db.QueryRowContext(ctx,
		`SELECT id, user_id, kind, label, created_at, last_used_at, expires_at FROM sessions WHERE token_hash = ?`, Hash(token)).
		Scan(&s.ID, &s.UserID, &s.Kind, &label, &s.CreatedAt, &lastUsed, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrInvalidSession
	}
	if err != nil {
		return Session{}, fmt.Errorf("세션 조회 실패: %w", err)
	}
	// 만료 행은 조회 시 판정만 하고 삭제하지 않는다(정리 작업은 Phase 1 범위 밖)
	nowMs := now.UnixMilli()
	if nowMs >= expiresAt {
		return Session{}, ErrInvalidSession
	}
	if label.Valid {
		s.Label = &label.String
	}
	if lastUsed.Valid {
		s.LastUsedAt = &lastUsed.Int64
	}
	if !lastUsed.Valid || nowMs-lastUsed.Int64 >= lastUsedGranularity.Milliseconds() {
		// 표시용 정보라 실패(예: 잠금 대기 초과)해도 요청은 계속한다
		if _, err := db.ExecContext(ctx, `UPDATE sessions SET last_used_at = ? WHERE id = ?`, nowMs, s.ID); err != nil {
			slog.Warn("세션 사용 시각 갱신 실패", "err", err)
		} else {
			s.LastUsedAt = &nowMs
		}
	}
	return s, nil
}

// List 는 사용자의 만료되지 않은 세션을 최근 생성 순으로 반환한다.
func List(ctx context.Context, db *sql.DB, userID string, now time.Time) ([]Session, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, user_id, kind, label, created_at, last_used_at FROM sessions
		WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC, id`, userID, now.UnixMilli())
	if err != nil {
		return nil, fmt.Errorf("세션 목록 조회 실패: %w", err)
	}
	defer rows.Close()
	out := []Session{}
	for rows.Next() {
		var s Session
		var label sql.NullString
		var lastUsed sql.NullInt64
		if err := rows.Scan(&s.ID, &s.UserID, &s.Kind, &label, &s.CreatedAt, &lastUsed); err != nil {
			return nil, fmt.Errorf("세션 목록 조회 실패: %w", err)
		}
		if label.Valid {
			s.Label = &label.String
		}
		if lastUsed.Valid {
			s.LastUsedAt = &lastUsed.Int64
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// DeleteByID 는 사용자 본인의 세션을 id 로 폐기한다. 없거나 다른 사용자의 것이면 ErrInvalidSession.
func DeleteByID(ctx context.Context, db *sql.DB, userID, id string) error {
	res, err := db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return fmt.Errorf("세션 폐기 실패: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		if err != nil {
			return fmt.Errorf("세션 폐기 실패: %w", err)
		}
		return ErrInvalidSession
	}
	return nil
}

// Delete 는 토큰의 세션을 삭제한다. 없으면 ErrInvalidSession.
func Delete(ctx context.Context, db *sql.DB, token string) error {
	res, err := db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, Hash(token))
	if err != nil {
		return fmt.Errorf("세션 삭제 실패: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("세션 삭제 실패: %w", err)
	}
	if n == 0 {
		return ErrInvalidSession
	}
	return nil
}
