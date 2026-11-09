// Package auth 는 GitHub OAuth PKCE·세션·토큰 암호화를 담당한다.
//
// Phase 6.1 Red 스텁: 시그니처만 고정한다. 실제 구현은 Phase 6.2.
package auth

import (
	"errors"
	"time"
)

var errNotImplemented = errors.New("not implemented")

// NewVerifier 는 RFC 7636 code_verifier(43~128자, unreserved 문자)를 생성한다.
func NewVerifier() (string, error) {
	return "", errNotImplemented
}

// Challenge 는 S256 code_challenge = base64url(sha256(verifier)) (패딩 없음)를 반환한다.
func Challenge(verifier string) string {
	return ""
}

// StateStore 는 OAuth state → verifier 를 메모리에 보관한다(TTL 10분, 1회 소비, 상한 1,000 — 초과 시 최고령 제거).
type StateStore struct{}

// NewStateStore 는 now 주입 시계를 쓰는 StateStore 를 만든다.
func NewStateStore(now func() time.Time) *StateStore {
	return &StateStore{}
}

// Put 은 state 와 verifier 를 now 시각으로 저장한다.
func (s *StateStore) Put(state, verifier string) {}

// Take 는 state 를 1회 소비한다. 없음·만료·이미 소비됨이면 ok=false.
func (s *StateStore) Take(state string) (verifier string, ok bool) {
	return "", false
}
