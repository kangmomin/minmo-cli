package auth

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// ErrInvalidSession 은 세션 없음·만료·위조·삭제를 모두 나타낸다(→ 401 unauthorized).
var ErrInvalidSession = errors.New("invalid session")

// NewToken 은 32B random base64url(패딩 없음, 43자) 불투명 세션 토큰을 만든다.
func NewToken() (string, error) {
	return "", errNotImplemented
}

// Hash 는 세션 토큰의 SHA-256 hex(소문자 64자)를 반환한다. DB 에는 이 값만 저장한다.
func Hash(token string) string {
	return ""
}

// Create 는 userID 의 세션을 now 기준 만료 30일로 저장하고 원문 토큰을 반환한다.
func Create(ctx context.Context, db *sql.DB, userID string, now time.Time) (string, error) {
	return "", errNotImplemented
}

// Lookup 은 토큰의 세션을 찾아 userID 를 반환한다. 없음·만료(now 기준)는 ErrInvalidSession.
func Lookup(ctx context.Context, db *sql.DB, token string, now time.Time) (string, error) {
	return "", errNotImplemented
}

// Delete 는 토큰의 세션을 삭제한다. 없으면 ErrInvalidSession.
func Delete(ctx context.Context, db *sql.DB, token string) error {
	return errNotImplemented
}
