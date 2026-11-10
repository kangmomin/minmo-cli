package auth

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// User 는 E3 /me 응답 원천이다.
type User struct {
	ID          string
	GitHubLogin string
	AvatarURL   *string
}

// UpsertUser 는 GitHub 사용자(github_id 기준)를 생성 또는 갱신하고 내부 사용자 id(`usr_<uuid>`)를 반환한다.
// accessTokenEnc 는 Seal 결과(AES-256-GCM)이며 재로그인 시 최신 토큰으로 교체된다.
func UpsertUser(ctx context.Context, db *sql.DB, gh GitHubUser, accessTokenEnc []byte, now time.Time) (string, error) {
	var id string
	err := db.QueryRowContext(ctx, `
		INSERT INTO users (id, github_id, login, avatar_url, access_token_enc, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (github_id) DO UPDATE SET
			login = excluded.login,
			avatar_url = excluded.avatar_url,
			access_token_enc = excluded.access_token_enc
		RETURNING id`,
		"usr_"+uuid.NewString(), gh.ID, gh.Login, gh.AvatarURL, accessTokenEnc, now.UnixMilli()).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("사용자 저장 실패: %w", err)
	}
	return id, nil
}

// GetUser 는 사용자 프로필을 조회한다.
func GetUser(ctx context.Context, db *sql.DB, userID string) (User, error) {
	u := User{ID: userID}
	err := db.QueryRowContext(ctx, `SELECT login, avatar_url FROM users WHERE id = ?`, userID).Scan(&u.GitHubLogin, &u.AvatarURL)
	if err != nil {
		return User{}, fmt.Errorf("사용자 조회 실패: %w", err)
	}
	return u, nil
}

// GitHubToken 은 저장된 GitHub access token 을 복호화해 반환한다.
func GitHubToken(ctx context.Context, db *sql.DB, key []byte, userID string) (string, error) {
	var enc []byte
	err := db.QueryRowContext(ctx, `SELECT access_token_enc FROM users WHERE id = ?`, userID).Scan(&enc)
	if err != nil {
		return "", fmt.Errorf("GitHub 토큰 조회 실패: %w", err)
	}
	plain, err := Open(key, enc)
	if err != nil {
		return "", fmt.Errorf("GitHub 토큰 복호화 실패: %w", err)
	}
	return string(plain), nil
}
