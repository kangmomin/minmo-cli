package settings

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrGlobalMissing 는 세션이 있는 사용자에게 전역 설정 행이 없는 불변식 위반이다(로그인 시 항상 생성).
var ErrGlobalMissing = errors.New("전역 설정 행 없음")

const selectColumns = `branch_template, etc_branch_name, worktree_path, main_clone_path, post_create_script, updated_at`

// Get 은 (userID, scope, owner, repo) 행을 조회한다. 행이 없으면 모든 필드 nil 인 Record.
// owner/repo 는 호출자가 소문자로 정규화해 넘기며, global 은 둘 다 "", org 는 repo "".
func Get(ctx context.Context, db *sql.DB, userID string, scope Scope, owner, repo string) (Record, error) {
	row := db.QueryRowContext(ctx,
		`SELECT `+selectColumns+` FROM settings WHERE user_id = ? AND scope = ? AND owner = ? AND repo = ?`,
		userID, string(scope), owner, repo)
	rec, err := scanRecord(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Record{}, nil
	}
	if err != nil {
		return Record{}, fmt.Errorf("설정 조회 실패: %w", err)
	}
	return rec, nil
}

// Upsert 는 행 전체를 in 으로 교체(nil 은 NULL 저장)하고 저장된 행을 반환한다. 검증은 호출자 책임.
// [Assumption] settings updatedAt 은 now 그대로다(단조 +1ms 는 충돌 판정에 쓰는 notes 만 적용).
func Upsert(ctx context.Context, db *sql.DB, userID string, scope Scope, owner, repo string, in Input, now time.Time) (Record, error) {
	row := db.QueryRowContext(ctx, `
		INSERT INTO settings (user_id, scope, owner, repo,
			branch_template, etc_branch_name, worktree_path, main_clone_path, post_create_script, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id, scope, owner, repo) DO UPDATE SET
			branch_template = excluded.branch_template,
			etc_branch_name = excluded.etc_branch_name,
			worktree_path = excluded.worktree_path,
			main_clone_path = excluded.main_clone_path,
			post_create_script = excluded.post_create_script,
			updated_at = excluded.updated_at
		RETURNING `+selectColumns,
		userID, string(scope), owner, repo,
		in.BranchTemplate, in.EtcBranchName, in.WorktreePath, in.MainClonePath, in.PostCreateScript,
		now.UnixMilli())
	rec, err := scanRecord(row)
	if err != nil {
		return Record{}, fmt.Errorf("설정 저장 실패: %w", err)
	}
	return rec, nil
}

// EnsureGlobalDefaults 는 전역 설정 행이 없을 때만 기본값으로 만든다(재로그인 시 기존 값 유지).
func EnsureGlobalDefaults(ctx context.Context, db *sql.DB, userID string, now time.Time) error {
	d := Defaults()
	_, err := db.ExecContext(ctx, `
		INSERT INTO settings (user_id, scope, owner, repo,
			branch_template, etc_branch_name, worktree_path, main_clone_path, post_create_script, updated_at)
		VALUES (?, ?, '', '', ?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id, scope, owner, repo) DO NOTHING`,
		userID, string(ScopeGlobal),
		d.BranchTemplate, d.EtcBranchName, d.WorktreePath, d.MainClonePath, d.PostCreateScript,
		now.UnixMilli())
	if err != nil {
		return fmt.Errorf("전역 기본 설정 생성 실패: %w", err)
	}
	return nil
}

// GetEffective 는 전역·조직·프로젝트 행을 한 번에 읽어 병합한다. owner/repo 는 소문자 정규화된 값.
func GetEffective(ctx context.Context, db *sql.DB, userID, owner, repo string) (Effective, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT scope, `+selectColumns+` FROM settings
		WHERE user_id = ? AND (
			scope = 'global'
			OR (scope = 'org' AND owner = ? AND repo = '')
			OR (scope = 'project' AND owner = ? AND repo = ?))`,
		userID, owner, owner, repo)
	if err != nil {
		return Effective{}, fmt.Errorf("effective 조회 실패: %w", err)
	}
	defer rows.Close()

	var global, org, project *Record
	for rows.Next() {
		var scope string
		var rec Record
		if err := rows.Scan(&scope, &rec.BranchTemplate, &rec.EtcBranchName, &rec.WorktreePath,
			&rec.MainClonePath, &rec.PostCreateScript, &rec.UpdatedAt); err != nil {
			return Effective{}, fmt.Errorf("effective 조회 실패: %w", err)
		}
		switch Scope(scope) {
		case ScopeGlobal:
			global = &rec
		case ScopeOrg:
			org = &rec
		case ScopeProject:
			project = &rec
		}
	}
	if err := rows.Err(); err != nil {
		return Effective{}, fmt.Errorf("effective 조회 실패: %w", err)
	}
	if global == nil {
		return Effective{}, ErrGlobalMissing
	}
	var orgIn, projectIn Input
	if org != nil {
		orgIn = org.Input
	}
	if project != nil {
		projectIn = project.Input
	}
	return Merge(global.Values(), orgIn, projectIn), nil
}

// Values 는 전역 행(5필드 NOT NULL — DB CHECK 로 보장)을 Values 로 변환한다.
func (r Record) Values() Values {
	deref := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	return Values{
		BranchTemplate:   deref(r.BranchTemplate),
		EtcBranchName:    deref(r.EtcBranchName),
		WorktreePath:     deref(r.WorktreePath),
		MainClonePath:    deref(r.MainClonePath),
		PostCreateScript: deref(r.PostCreateScript),
	}
}

func scanRecord(row *sql.Row) (Record, error) {
	var rec Record
	err := row.Scan(&rec.BranchTemplate, &rec.EtcBranchName, &rec.WorktreePath,
		&rec.MainClonePath, &rec.PostCreateScript, &rec.UpdatedAt)
	return rec, err
}
