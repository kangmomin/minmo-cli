package auth

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
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

// Create 는 userID 의 세션을 now 기준 만료 30일로 저장하고 원문 토큰을 반환한다.
func Create(ctx context.Context, db *sql.DB, userID string, now time.Time) (string, error) {
	token, err := NewToken()
	if err != nil {
		return "", fmt.Errorf("세션 토큰 생성 실패: %w", err)
	}
	_, err = db.ExecContext(ctx,
		`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
		uuid.NewString(), userID, Hash(token), now.Add(SessionTTL).UnixMilli(), now.UnixMilli())
	if err != nil {
		return "", fmt.Errorf("세션 저장 실패: %w", err)
	}
	return token, nil
}

// Lookup 은 토큰의 세션을 찾아 userID 를 반환한다. 없음·만료(now 기준)는 ErrInvalidSession.
func Lookup(ctx context.Context, db *sql.DB, token string, now time.Time) (string, error) {
	var userID string
	var expiresAt int64
	err := db.QueryRowContext(ctx,
		`SELECT user_id, expires_at FROM sessions WHERE token_hash = ?`, Hash(token)).Scan(&userID, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrInvalidSession
	}
	if err != nil {
		return "", fmt.Errorf("세션 조회 실패: %w", err)
	}
	// 만료 행은 조회 시 판정만 하고 삭제하지 않는다(정리 작업은 Phase 1 범위 밖)
	if now.UnixMilli() >= expiresAt {
		return "", ErrInvalidSession
	}
	return userID, nil
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
