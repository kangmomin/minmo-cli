package settings

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// PC 별 설정 — 같은 계정의 PC 들이 한 서버를 쓸 때, 그 PC 에만 맞는 값(작업 폴더 경로·생성 후 스크립트·
// 무시된 파일 제외 목록)은 PC 마다 따로 둘 수 있다. 이름을 정하는 값(브랜치 이름 틀 등)은 언제나 함께 쓴다.
// 나누는 기준은 PC 사이 동기화(/me/sync)가 보내지 않는 값과 같다.

// local 은 PC 별로 둘 수 있는 필드다.
type local struct {
	WorktreePath          *string
	MainClonePath         *string
	PostCreateScript      *string
	PostCreateScriptPosix *string
	IgnoredCopyExclude    *string
	UpdatedAt             int64
}

// overlay 는 rec 의 PC 별 필드를 그 PC 의 값으로 바꾼다. 수정 시각은 둘 중 늦은 쪽.
func (l local) overlay(rec *Record) {
	rec.WorktreePath = l.WorktreePath
	rec.MainClonePath = l.MainClonePath
	rec.PostCreateScript = l.PostCreateScript
	rec.PostCreateScriptPosix = l.PostCreateScriptPosix
	rec.IgnoredCopyExclude = l.IgnoredCopyExclude
	if rec.UpdatedAt == nil || *rec.UpdatedAt < l.UpdatedAt {
		at := l.UpdatedAt
		rec.UpdatedAt = &at
	}
}

const localColumns = `worktree_path, main_clone_path, post_create_script, post_create_script_posix, ignored_copy_exclude, updated_at`

// GetForDevice 는 Get 과 같되, 그 PC 의 행이 있으면 PC 별 필드를 그 값으로 돌려준다.
// 행이 없으면 함께 쓰는 값 그대로다(PC 별로 처음 나눌 때 지금 값에서 시작한다).
func GetForDevice(ctx context.Context, db *sql.DB, userID, device string, scope Scope, owner, repo string) (Record, error) {
	rec, err := Get(ctx, db, userID, scope, owner, repo)
	if err != nil {
		return Record{}, err
	}
	var l local
	err = db.QueryRowContext(ctx,
		`SELECT `+localColumns+` FROM device_settings WHERE user_id = ? AND device_id = ? AND scope = ? AND owner = ? AND repo = ?`,
		userID, device, string(scope), owner, repo).
		Scan(&l.WorktreePath, &l.MainClonePath, &l.PostCreateScript, &l.PostCreateScriptPosix, &l.IgnoredCopyExclude, &l.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return rec, nil
	}
	if err != nil {
		return Record{}, fmt.Errorf("PC 별 설정 조회 실패: %w", err)
	}
	l.overlay(&rec)
	return rec, nil
}

// UpsertForDevice 는 in 의 PC 별 필드를 그 PC 의 행에, 나머지를 함께 쓰는 행에 저장하고 합친 행을 반환한다.
// 함께 쓰는 행의 PC 별 필드는 건드리지 않는다 — 나누지 않은 다른 PC 가 그 값을 계속 쓴다.
func UpsertForDevice(ctx context.Context, db *sql.DB, userID, device string, scope Scope, owner, repo string, in Input, now time.Time) (Record, error) {
	fail := func(err error) (Record, error) { return Record{}, fmt.Errorf("PC 별 설정 저장 실패: %w", err) }
	at := now.UnixMilli()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fail(err)
	}
	defer func() { _ = tx.Rollback() }()

	// INSERT … ON CONFLICT 는 쓰지 않는다 — global 행은 CHECK(NOT NULL) 이 넣으려는 행에 먼저 걸린다
	res, err := tx.ExecContext(ctx, `
		UPDATE settings SET branch_template = ?, etc_branch_name = ?, sparse_paths = ?, updated_at = ?
		WHERE user_id = ? AND scope = ? AND owner = ? AND repo = ?`,
		in.BranchTemplate, in.EtcBranchName, in.SparsePaths, at, userID, string(scope), owner, repo)
	if err != nil {
		return fail(err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fail(err)
	}
	if n == 0 {
		if scope == ScopeGlobal {
			return Record{}, ErrGlobalMissing
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO settings (user_id, scope, owner, repo, branch_template, etc_branch_name, sparse_paths, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			userID, string(scope), owner, repo, in.BranchTemplate, in.EtcBranchName, in.SparsePaths, at); err != nil {
			return fail(err)
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO device_settings (user_id, device_id, scope, owner, repo,
			worktree_path, main_clone_path, post_create_script, post_create_script_posix, ignored_copy_exclude, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id, device_id, scope, owner, repo) DO UPDATE SET
			worktree_path = excluded.worktree_path,
			main_clone_path = excluded.main_clone_path,
			post_create_script = excluded.post_create_script,
			post_create_script_posix = excluded.post_create_script_posix,
			ignored_copy_exclude = excluded.ignored_copy_exclude,
			updated_at = excluded.updated_at`,
		userID, device, string(scope), owner, repo,
		in.WorktreePath, in.MainClonePath, in.PostCreateScript, in.PostCreateScriptPosix, in.IgnoredCopyExclude, at); err != nil {
		return fail(err)
	}
	if err := tx.Commit(); err != nil {
		return fail(err)
	}
	return GetForDevice(ctx, db, userID, device, scope, owner, repo)
}

// GetEffectiveForDevice 는 GetEffective 와 같되, 단계마다 그 PC 의 값을 먼저 쓴다.
func GetEffectiveForDevice(ctx context.Context, db *sql.DB, userID, device, owner, repo string) (Effective, error) {
	recs, err := loadScopes(ctx, db, userID, owner, repo)
	if err != nil {
		return Effective{}, err
	}
	rows, err := db.QueryContext(ctx, `
		SELECT scope, `+localColumns+` FROM device_settings
		WHERE user_id = ? AND device_id = ? AND (
			scope = 'global'
			OR (scope = 'org' AND owner = ? AND repo = '')
			OR (scope = 'project' AND owner = ? AND repo = ?))`,
		userID, device, owner, owner, repo)
	if err != nil {
		return Effective{}, fmt.Errorf("PC 별 effective 조회 실패: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var scope string
		var l local
		if err := rows.Scan(&scope, &l.WorktreePath, &l.MainClonePath, &l.PostCreateScript, &l.PostCreateScriptPosix, &l.IgnoredCopyExclude, &l.UpdatedAt); err != nil {
			return Effective{}, fmt.Errorf("PC 별 effective 조회 실패: %w", err)
		}
		rec := recs[Scope(scope)]
		if rec == nil {
			// 함께 쓰는 행은 UpsertForDevice 가 항상 같이 만들지만, 없어도 PC 의 값은 쓴다
			rec = &Record{}
			recs[Scope(scope)] = rec
		}
		l.overlay(rec)
	}
	if err := rows.Err(); err != nil {
		return Effective{}, fmt.Errorf("PC 별 effective 조회 실패: %w", err)
	}
	return mergeScopes(recs)
}
