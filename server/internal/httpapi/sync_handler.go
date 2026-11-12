package httpapi

import (
	"net/http"
	"strings"

	"github.com/kangmomin/minmo-cli/server/internal/settings"
)

// PC 사이 동기화(데스크톱의 "다른 PC") — 이 서버의 설정·메모를 내보내고, 받은 것 중 더 새로운 것만 넣는다.
// 어느 쪽이 이길지(그리고 메모의 충돌 사본)는 두 PC 의 내용을 함께 보는 데스크톱 앱이 정한다. 서버는 "더 새로운 것만 넣는다"만 지킨다.
//
// 설정은 이름을 정하는 값(브랜치 이름 틀·기타 브랜치 이름·sparse 경로)만 다룬다. 작업 폴더 경로와 생성 후 스크립트는
// 내보내지도 받지도 않는다 — 그 PC 의 폴더·명령이라 다른 PC 에 맞지 않고, 받아들이면 다른 PC 가 이 PC 에서 실행될
// 명령을 정할 수 있게 된다. 이 경로로는 그 값들이 바뀌지 않는다는 것을 서버가 보장한다.

// 동기화 요청 상한 — 메모(각 1 MiB)가 여럿 실린다
const maxSyncRequestBytes = 64 << 20

// 앞선 시각으로 찍힌 항목이 영원히 이기지 않게, 지금보다 이만큼 넘게 앞선 시각은 지금으로 본다(PC 시계 차이는 허용)
const maxSyncClockSkewMs = 5 * 60 * 1000

type syncSettingJSON struct {
	Scope          string  `json:"scope"`
	Owner          string  `json:"owner"`
	Repo           string  `json:"repo"`
	BranchTemplate *string `json:"branchTemplate"`
	EtcBranchName  *string `json:"etcBranchName"`
	SparsePaths    *string `json:"sparsePaths"`
	UpdatedAtMs    int64   `json:"updatedAtMs"`
}

type syncNoteJSON struct {
	Owner       string `json:"owner"`
	Repo        string `json:"repo"`
	Key         string `json:"key"`
	Body        string `json:"body"`
	UpdatedAtMs int64  `json:"updatedAtMs"`
}

type syncDocJSON struct {
	// 이 서버의 지금 시각 — 받는 쪽이 두 PC 의 시계 차이를 재서 수정 시각을 견준다
	NowMs    int64             `json:"nowMs"`
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
	doc := syncDocJSON{NowMs: a.now().UnixMilli(), Settings: []syncSettingJSON{}, Notes: []syncNoteJSON{}}
	rows, err := a.db.QueryContext(r.Context(), `
		SELECT scope, owner, repo, branch_template, etc_branch_name, sparse_paths, updated_at
		FROM settings WHERE user_id = ? ORDER BY scope, owner, repo`, s.userID)
	if err != nil {
		a.internal(w, r, err)
		return
	}
	for rows.Next() {
		var it syncSettingJSON
		if err := rows.Scan(&it.Scope, &it.Owner, &it.Repo, &it.BranchTemplate, &it.EtcBranchName, &it.SparsePaths, &it.UpdatedAtMs); err != nil {
			rows.Close()
			a.internal(w, r, err)
			return
		}
		doc.Settings = append(doc.Settings, it)
	}
	// 읽다가 끊긴 것을 "여기까지가 전부"로 내보내지 않는다 — 받는 쪽이 없는 항목을 새로 만들어 넣는다
	if err := rows.Err(); err != nil {
		rows.Close()
		a.internal(w, r, err)
		return
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
	if err := notes.Err(); err != nil {
		notes.Close()
		a.internal(w, r, err)
		return
	}
	if err := notes.Close(); err != nil {
		a.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

// 경로에 쓰는 이름 규칙(pathName 과 같다): 글자 규칙 + "."·".." 금지
func validSyncName(s string) bool {
	return reOwnerRepo.MatchString(s) && s != "." && s != ".."
}

// 설정 항목이 저장 규칙에 맞는가. owner/repo 는 소문자로 맞춘다.
// 검증은 "이 값들만 있는 행"으로 한다(전역은 나머지를 기본값으로 채워 본다 — 실제로는 이 서버의 값이 그대로 남는다).
func validSyncSetting(it *syncSettingJSON) bool {
	it.Owner, it.Repo = strings.ToLower(it.Owner), strings.ToLower(it.Repo)
	scope := settings.Scope(it.Scope)
	in := settings.Input{BranchTemplate: it.BranchTemplate, EtcBranchName: it.EtcBranchName, SparsePaths: it.SparsePaths}
	switch scope {
	case settings.ScopeGlobal:
		if it.Owner != "" || it.Repo != "" || it.BranchTemplate == nil || it.EtcBranchName == nil {
			return false
		}
		d := settings.Defaults()
		in.WorktreePath, in.MainClonePath, in.PostCreateScript, in.PostCreateScriptPosix = &d.WorktreePath, &d.MainClonePath, &d.PostCreateScript, &d.PostCreateScriptPosix
		if in.SparsePaths == nil {
			in.SparsePaths = &d.SparsePaths
		}
	case settings.ScopeOrg:
		if !validSyncName(it.Owner) || it.Repo != "" {
			return false
		}
	case settings.ScopeProject:
		if !validSyncName(it.Owner) || !validSyncName(it.Repo) {
			return false
		}
	default:
		return false
	}
	code, _ := settings.ValidateInput(scope, in)
	return code == ""
}

func validSyncNote(it *syncNoteJSON) bool {
	it.Owner, it.Repo = strings.ToLower(it.Owner), strings.ToLower(it.Repo)
	return validSyncName(it.Owner) && validSyncName(it.Repo) && reIssueKey.MatchString(it.Key) && len(it.Body) <= maxNoteBodyBytes
}

// PUT /me/sync — 받은 항목 중 이 서버의 것보다 더 새로운 것만 넣는다.
// 설정은 이름을 정하는 세 값만 바꾼다: 있는 행은 그 세 값만 고치고(경로·스크립트는 그대로), 없는 행은 나머지를 비워 만든다.
// 전역 설정은 고치기만 한다(전역 행은 로그인할 때 생기며, 모든 값이 있어야 한다).
func (a *api) syncImport(w http.ResponseWriter, r *http.Request, s session) {
	var in syncDocJSON
	if e := decodeJSON(w, r, maxSyncRequestBytes, &in); e != nil {
		writeAPIError(w, e)
		return
	}
	now := a.now().UnixMilli()
	clamp := func(ms int64) int64 {
		if ms > now+maxSyncClockSkewMs {
			return now
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
			UPDATE settings SET branch_template = ?, etc_branch_name = ?, sparse_paths = ?, updated_at = ?
			WHERE user_id = ? AND scope = ? AND owner = ? AND repo = ? AND updated_at < ?`,
			it.BranchTemplate, it.EtcBranchName, it.SparsePaths, clamp(it.UpdatedAtMs),
			s.userID, it.Scope, it.Owner, it.Repo, clamp(it.UpdatedAtMs))
		if err != nil {
			a.internal(w, r, err)
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 && settings.Scope(it.Scope) != settings.ScopeGlobal {
			// 행이 없으면 만든다(있는데 더 새롭지 않아 안 바뀐 경우는 DO NOTHING)
			res, err = tx.ExecContext(r.Context(), `
				INSERT INTO settings (user_id, scope, owner, repo, branch_template, etc_branch_name, sparse_paths, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (user_id, scope, owner, repo) DO NOTHING`,
				s.userID, it.Scope, it.Owner, it.Repo, it.BranchTemplate, it.EtcBranchName, it.SparsePaths, clamp(it.UpdatedAtMs))
			if err != nil {
				a.internal(w, r, err)
				return
			}
			n, _ = res.RowsAffected()
		}
		if n > 0 {
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
