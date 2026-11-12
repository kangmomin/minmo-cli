package httpapi

import (
	"net/http"
	"strings"

	"github.com/kangmomin/minmo-cli/server/internal/settings"
)

// PC 사이 동기화(데스크톱의 "다른 PC") — 이 서버의 설정·메모를 통째로 내보내고, 받은 것 중 더 새로운 것만 넣는다.
// 어느 쪽이 이길지(그리고 메모의 충돌 사본)는 두 PC 의 내용을 함께 보는 데스크톱 앱이 정한다. 서버는 "더 새로운 것만 넣는다"만 지킨다.

// 동기화 요청 상한 — 메모(각 1 MiB)가 여럿 실린다
const maxSyncRequestBytes = 64 << 20

// 앞선 시각으로 찍힌 항목이 영원히 이기지 않게, 지금보다 이만큼 넘게 앞선 시각은 지금으로 본다(PC 시계 차이는 허용)
const maxSyncClockSkewMs = 5 * 60 * 1000

type syncSettingJSON struct {
	Scope string `json:"scope"`
	Owner string `json:"owner"`
	Repo  string `json:"repo"`
	settings.Input
	UpdatedAtMs int64 `json:"updatedAtMs"`
}

type syncNoteJSON struct {
	Owner       string `json:"owner"`
	Repo        string `json:"repo"`
	Key         string `json:"key"`
	Body        string `json:"body"`
	UpdatedAtMs int64  `json:"updatedAtMs"`
}

type syncDocJSON struct {
	Settings []syncSettingJSON `json:"settings"`
	Notes    []syncNoteJSON    `json:"notes"`
}

type syncResultJSON struct {
	// 넣은 수(더 새로워서 받아들인 것)
	Settings int `json:"settings"`
	Notes    int `json:"notes"`
	// 넣지 않은 수 — 이 서버의 것이 같거나 더 새롭거나, 값이 규칙에 맞지 않는 것
	Skipped int `json:"skipped"`
}

// GET /me/sync
func (a *api) syncExport(w http.ResponseWriter, r *http.Request, s session) {
	doc := syncDocJSON{Settings: []syncSettingJSON{}, Notes: []syncNoteJSON{}}
	rows, err := a.db.QueryContext(r.Context(), `
		SELECT scope, owner, repo, branch_template, etc_branch_name, worktree_path, main_clone_path,
		       post_create_script, sparse_paths, post_create_script_posix, updated_at
		FROM settings WHERE user_id = ? ORDER BY scope, owner, repo`, s.userID)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	for rows.Next() {
		var it syncSettingJSON
		if err := rows.Scan(&it.Scope, &it.Owner, &it.Repo, &it.BranchTemplate, &it.EtcBranchName, &it.WorktreePath, &it.MainClonePath,
			&it.PostCreateScript, &it.SparsePaths, &it.PostCreateScriptPosix, &it.UpdatedAtMs); err != nil {
			rows.Close()
			a.internal(w, r, err)
			return
		}
		doc.Settings = append(doc.Settings, it)
	}
	if err := rows.Close(); err != nil {
		a.internal(w, r, err)
		return
	}
	notes, err := a.db.QueryContext(r.Context(),
		`SELECT owner, repo, issue_key, body, updated_at FROM issue_notes WHERE user_id = ? ORDER BY owner, repo, issue_key`, s.userID)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	for notes.Next() {
		var it syncNoteJSON
		if err := notes.Scan(&it.Owner, &it.Repo, &it.Key, &it.Body, &it.UpdatedAtMs); err != nil {
			notes.Close()
			a.internal(w, r, err)
			return
		}
		doc.Notes = append(doc.Notes, it)
	}
	if err := notes.Close(); err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

// 설정 항목이 저장 규칙에 맞는가(경로 이름 규칙 + 설정 검증). owner/repo 는 소문자로 맞춘다
func validSyncSetting(it *syncSettingJSON) bool {
	it.Owner, it.Repo = strings.ToLower(it.Owner), strings.ToLower(it.Repo)
	switch settings.Scope(it.Scope) {
	case settings.ScopeGlobal:
		if it.Owner != "" || it.Repo != "" {
			return false
		}
	case settings.ScopeOrg:
		if !reOwnerRepo.MatchString(it.Owner) || it.Repo != "" {
			return false
		}
	case settings.ScopeProject:
		if !reOwnerRepo.MatchString(it.Owner) || !reOwnerRepo.MatchString(it.Repo) {
			return false
		}
	default:
		return false
	}
	code, _ := settings.ValidateInput(settings.Scope(it.Scope), it.Input)
	return code == ""
}

func validSyncNote(it *syncNoteJSON) bool {
	it.Owner, it.Repo = strings.ToLower(it.Owner), strings.ToLower(it.Repo)
	return reOwnerRepo.MatchString(it.Owner) && reOwnerRepo.MatchString(it.Repo) && reIssueKey.MatchString(it.Key) && len(it.Body) <= maxNoteBodyBytes
}

// PUT /me/sync — 받은 항목 중 이 서버의 것보다 더 새로운 것만 넣는다(받은 수정 시각을 그대로 둔다 — 다시 맞출 때 같다고 본다)
func (a *api) syncImport(w http.ResponseWriter, r *http.Request, s session) {
	var in syncDocJSON
	if e := decodeJSON(w, r, maxSyncRequestBytes, &in); e != nil {
		writeAPIError(w, e)
		return
	}
	limit := a.now().UnixMilli() + maxSyncClockSkewMs
	clamp := func(ms int64) int64 {
		if ms > limit {
			return a.now().UnixMilli()
		}
		return ms
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	defer tx.Rollback() //nolint:errcheck // 커밋한 뒤에는 아무 일도 하지 않는다
	var out syncResultJSON
	for i := range in.Settings {
		it := &in.Settings[i]
		if it.UpdatedAtMs <= 0 || !validSyncSetting(it) {
			out.Skipped++
			continue
		}
		res, err := tx.ExecContext(r.Context(), `
			INSERT INTO settings (user_id, scope, owner, repo,
				branch_template, etc_branch_name, worktree_path, main_clone_path, post_create_script, sparse_paths, post_create_script_posix, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (user_id, scope, owner, repo) DO UPDATE SET
				branch_template = excluded.branch_template,
				etc_branch_name = excluded.etc_branch_name,
				worktree_path = excluded.worktree_path,
				main_clone_path = excluded.main_clone_path,
				post_create_script = excluded.post_create_script,
				sparse_paths = excluded.sparse_paths,
				post_create_script_posix = excluded.post_create_script_posix,
				updated_at = excluded.updated_at
			WHERE excluded.updated_at > settings.updated_at`,
			s.userID, it.Scope, it.Owner, it.Repo,
			it.BranchTemplate, it.EtcBranchName, it.WorktreePath, it.MainClonePath, it.PostCreateScript, it.SparsePaths, it.PostCreateScriptPosix,
			clamp(it.UpdatedAtMs))
		if err != nil {
			a.internal(w, r, err)
			return
		}
		if n, _ := res.RowsAffected(); n > 0 {
			out.Settings++
		} else {
			out.Skipped++
		}
	}
	for i := range in.Notes {
		it := &in.Notes[i]
		if it.UpdatedAtMs <= 0 || !validSyncNote(it) {
			out.Skipped++
			continue
		}
		res, err := tx.ExecContext(r.Context(), `
			INSERT INTO issue_notes (user_id, owner, repo, issue_key, body, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (user_id, owner, repo, issue_key) DO UPDATE SET
				body = excluded.body, updated_at = excluded.updated_at
			WHERE excluded.updated_at > issue_notes.updated_at`,
			s.userID, it.Owner, it.Repo, it.Key, it.Body, clamp(it.UpdatedAtMs))
		if err != nil {
			a.internal(w, r, err)
			return
		}
		if n, _ := res.RowsAffected(); n > 0 {
			out.Notes++
		} else {
			out.Skipped++
		}
	}
	if err := tx.Commit(); err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
