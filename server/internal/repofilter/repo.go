// Package repofilter 는 사용자별 "보일 저장소" 선택(repo_filters) 저장소다.
// 데스크탑 트리와 원격 CLI 가 같은 선택을 쓰므로 서버에 둔다.
package repofilter

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
)

// MaxEntries 는 선택 항목 수 상한이다.
const MaxEntries = 1000

var reName = regexp.MustCompile(`^[a-z0-9_.-]{1,100}$`)

// Filter 는 현재 선택이다. Repos == nil 이면 전체 표시, 빈 슬라이스는 전부 숨김.
// 행이 없으면 Repos nil · UpdatedAt nil.
type Filter struct {
	Repos     []string
	UpdatedAt *int64 // epoch ms
}

// BaseKind 는 baseUpdatedAt 3분기다(notes 와 같은 의미).
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

// ErrConflict 는 baseUpdatedAt 불일치(다른 기기가 먼저 저장)다.
var ErrConflict = errors.New("repo filter conflict")

// Normalize 는 항목을 소문자로 바꾸고 검증·중복 제거·정렬한다. 형식이 틀리면 ok=false.
// 허용: "owner/repo", "owner/*"(조직 전체). 각 부분은 GitHub 이름 문자만, `.`·`..` 금지.
func Normalize(entries []string) (out []string, ok bool) {
	if len(entries) > MaxEntries {
		return nil, false
	}
	out = make([]string, 0, len(entries))
	for _, e := range entries {
		owner, repo, found := strings.Cut(strings.ToLower(strings.TrimSpace(e)), "/")
		if !found || !validName(owner) || (repo != "*" && !validName(repo)) {
			return nil, false
		}
		out = append(out, owner+"/"+repo)
	}
	slices.Sort(out)
	return slices.Compact(out), true
}

func validName(s string) bool {
	return reName.MatchString(s) && s != "." && s != ".."
}

// Get 은 선택을 조회한다.
func Get(ctx context.Context, db *sql.DB, userID string) (Filter, error) {
	var raw sql.NullString
	var at int64
	err := db.QueryRowContext(ctx, `SELECT repos, updated_at FROM repo_filters WHERE user_id = ?`, userID).Scan(&raw, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return Filter{}, nil
	}
	if err != nil {
		return Filter{}, fmt.Errorf("저장소 선택 조회 실패: %w", err)
	}
	return decode(raw, at)
}

// 각 분기는 조건 검사와 쓰기를 SQL 한 문장으로 원자화한다. 새 updated_at = MAX(now, prev+1).
const (
	sqlPutOmitted = `
		INSERT INTO repo_filters (user_id, repos, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET
			repos = excluded.repos,
			updated_at = MAX(excluded.updated_at, repo_filters.updated_at + 1)
		RETURNING repos, updated_at`
	sqlPutNull = `
		INSERT INTO repo_filters (user_id, repos, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (user_id) DO NOTHING
		RETURNING repos, updated_at`
	sqlPutValue = `
		UPDATE repo_filters SET repos = ?, updated_at = MAX(?, updated_at + 1)
		WHERE user_id = ? AND updated_at = ?
		RETURNING repos, updated_at`
)

// Put 은 선택 전체를 교체한다(repos nil = 전체 표시). base 조건이 맞지 않으면 ErrConflict.
func Put(ctx context.Context, db *sql.DB, userID string, repos []string, base Base, now time.Time) (Filter, error) {
	var stored sql.NullString
	if repos != nil {
		b, err := json.Marshal(repos)
		if err != nil {
			return Filter{}, err
		}
		stored = sql.NullString{String: string(b), Valid: true}
	}
	nowMs := now.UnixMilli()
	var row *sql.Row
	switch base.Kind {
	case BaseNull:
		row = db.QueryRowContext(ctx, sqlPutNull, userID, stored, nowMs)
	case BaseValue:
		row = db.QueryRowContext(ctx, sqlPutValue, stored, nowMs, userID, base.Ms)
	default:
		row = db.QueryRowContext(ctx, sqlPutOmitted, userID, stored, nowMs)
	}
	var raw sql.NullString
	var at int64
	err := row.Scan(&raw, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return Filter{}, ErrConflict
	}
	if err != nil {
		return Filter{}, fmt.Errorf("저장소 선택 저장 실패: %w", err)
	}
	return decode(raw, at)
}

func decode(raw sql.NullString, at int64) (Filter, error) {
	f := Filter{UpdatedAt: &at}
	if raw.Valid {
		if err := json.Unmarshal([]byte(raw.String), &f.Repos); err != nil {
			return Filter{}, fmt.Errorf("저장소 선택 해석 실패: %w", err)
		}
		if f.Repos == nil {
			f.Repos = []string{}
		}
	}
	return f, nil
}
