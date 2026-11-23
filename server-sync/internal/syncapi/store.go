// Package syncapi 는 설정 페어링 동기화 서버의 저장소와 HTTP 핸들러다.
// payload 는 서버가 해석하지 않는 불투명 JSON 이며, 토큰·페어링 코드는 SHA-256 해시만 저장한다.
package syncapi

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
)

const schema = `
CREATE TABLE IF NOT EXISTS pairs (
  id TEXT PRIMARY KEY,
  code_hash TEXT,
  code_expires_at INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pairs_code ON pairs(code_hash) WHERE code_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS devices (
  token_hash TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);`

// State 는 페어의 현재 동기화 상태다.
type State struct {
	Rev       int64  `json:"rev"`
	Payload   string `json:"payload"`
	UpdatedAt int64  `json:"updatedAt"`
}

type Store struct{ db *sql.DB }

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// SQLite 쓰기 경합을 피하려고 단일 연결로 직렬화한다
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA foreign_keys=ON`); err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func hash(v string) string {
	sum := sha256.Sum256([]byte(v))
	return hex.EncodeToString(sum[:])
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand 실패는 복구 불가
	}
	return hex.EncodeToString(b)
}

// 헷갈리는 문자(0/O, 1/I)를 뺀 코드 알파벳. 10자 = 약 49bit.
const codeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

func newCode() string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	out := make([]byte, 0, 11)
	for i, x := range b {
		if i == 5 {
			out = append(out, '-')
		}
		out = append(out, codeAlphabet[int(x)%len(codeAlphabet)])
	}
	return string(out)
}

func normalizeCode(c string) string {
	// 하이픈·공백 유무와 대소문자는 구분하지 않는다
	return strings.ToUpper(strings.NewReplacer(" ", "", "-", "").Replace(strings.TrimSpace(c)))
}

// CreatePair 는 새 페어와 첫 기기 토큰, 1회용 코드를 만든다.
func (s *Store) CreatePair(nowMs, codeTTLMs int64) (pairID, code, token string, err error) {
	pairID, code, token = randHex(8), newCode(), randHex(32)
	tx, err := s.db.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO pairs(id,code_hash,code_expires_at,updated_at) VALUES(?,?,?,?)`,
		pairID, hash(normalizeCode(code)), nowMs+codeTTLMs, nowMs); err != nil {
		return
	}
	if _, err = tx.Exec(`INSERT INTO devices(token_hash,pair_id,created_at) VALUES(?,?,?)`, hash(token), pairID, nowMs); err != nil {
		return
	}
	err = tx.Commit()
	return
}

// Join 은 코드를 소비하고 새 기기 토큰을 발급한다. 만료·미존재 코드는 ErrNotFound.
func (s *Store) Join(code string, nowMs int64) (pairID, token string, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	// 조회와 소비를 한 UPDATE 로 묶어 같은 코드의 동시 사용을 막는다
	err = tx.QueryRow(`UPDATE pairs SET code_hash=NULL WHERE code_hash=? AND code_expires_at>? RETURNING id`,
		hash(normalizeCode(code)), nowMs).Scan(&pairID)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
		return
	}
	if err != nil {
		return
	}
	token = randHex(32)
	if _, err = tx.Exec(`INSERT INTO devices(token_hash,pair_id,created_at) VALUES(?,?,?)`, hash(token), pairID, nowMs); err != nil {
		return
	}
	err = tx.Commit()
	return
}

// Authorize 는 토큰이 해당 페어의 기기인지 확인한다.
func (s *Store) Authorize(pairID, token string) bool {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM devices WHERE token_hash=? AND pair_id=?`, hash(token), pairID).Scan(&n)
	return err == nil && n == 1
}

// ReissueCode 는 기존 페어에 새 1회용 코드를 발급한다(이전 코드는 무효).
func (s *Store) ReissueCode(pairID string, nowMs, ttlMs int64) (string, error) {
	code := newCode()
	res, err := s.db.Exec(`UPDATE pairs SET code_hash=?, code_expires_at=? WHERE id=?`, hash(normalizeCode(code)), nowMs+ttlMs, pairID)
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", ErrNotFound
	}
	return code, nil
}

func (s *Store) Get(pairID string) (State, error) {
	var st State
	err := s.db.QueryRow(`SELECT rev,payload,updated_at FROM pairs WHERE id=?`, pairID).Scan(&st.Rev, &st.Payload, &st.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return st, ErrNotFound
	}
	return st, err
}

// Put 은 baseRev 가 현재 rev 와 같을 때만 저장하고 rev 를 올린다. 다르면 ErrConflict 와 현재 상태를 돌려준다.
func (s *Store) Put(pairID string, baseRev int64, payload string, nowMs int64) (State, error) {
	res, err := s.db.Exec(`UPDATE pairs SET payload=?, rev=rev+1, updated_at=? WHERE id=? AND rev=?`, payload, nowMs, pairID, baseRev)
	if err != nil {
		return State{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		cur, gerr := s.Get(pairID)
		if gerr != nil {
			return State{}, gerr
		}
		return cur, ErrConflict
	}
	return s.Get(pairID)
}
