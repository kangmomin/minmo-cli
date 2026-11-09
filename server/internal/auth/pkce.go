// Package auth 는 GitHub OAuth PKCE·세션·토큰 암호화를 담당한다.
package auth

import (
	"container/list"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"sync"
	"time"
)

const (
	stateTTL = 10 * time.Minute
	stateCap = 1000
)

// randomURLToken 은 n 바이트 난수의 base64url(패딩 없음) 문자열이다.
func randomURLToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// NewVerifier 는 RFC 7636 code_verifier(43~128자, unreserved 문자)를 생성한다.
// 32B 난수의 base64url = 43자([A-Za-z0-9_-]).
func NewVerifier() (string, error) {
	return randomURLToken(32)
}

// NewState 는 OAuth state(32B 난수 base64url)를 생성한다.
func NewState() (string, error) {
	return randomURLToken(32)
}

// Challenge 는 S256 code_challenge = base64url(sha256(verifier)) (패딩 없음)를 반환한다.
func Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

type pendingState struct {
	state     string
	verifier  string
	createdAt time.Time
}

// StateStore 는 OAuth state → verifier 를 메모리에 보관한다(TTL 10분, 1회 소비, 상한 1,000 — 초과 시 최고령 제거).
// 단일 서버 인스턴스 전제(A-P11) — 재시작 시 진행 중 로그인은 invalid_state 가 된다.
type StateStore struct {
	mu    sync.Mutex
	now   func() time.Time
	order *list.List // 삽입 순(최고령이 Front)
	byKey map[string]*list.Element
}

// NewStateStore 는 now 주입 시계를 쓰는 StateStore 를 만든다.
func NewStateStore(now func() time.Time) *StateStore {
	return &StateStore{now: now, order: list.New(), byKey: map[string]*list.Element{}}
}

// Put 은 state 와 verifier 를 now 시각으로 저장한다.
func (s *StateStore) Put(state, verifier string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.purgeExpired(now)
	if el, ok := s.byKey[state]; ok {
		s.remove(el)
	}
	for s.order.Len() >= stateCap {
		s.remove(s.order.Front())
	}
	s.byKey[state] = s.order.PushBack(&pendingState{state: state, verifier: verifier, createdAt: now})
}

// Take 는 state 를 1회 소비한다. 없음·만료·이미 소비됨이면 ok=false.
func (s *StateStore) Take(state string) (verifier string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	el, found := s.byKey[state]
	if !found {
		return "", false
	}
	s.remove(el)
	p := el.Value.(*pendingState)
	if expired(p, s.now()) {
		return "", false
	}
	return p.verifier, true
}

func (s *StateStore) purgeExpired(now time.Time) {
	for el := s.order.Front(); el != nil && expired(el.Value.(*pendingState), now); el = s.order.Front() {
		s.remove(el)
	}
}

func (s *StateStore) remove(el *list.Element) {
	delete(s.byKey, el.Value.(*pendingState).state)
	s.order.Remove(el)
}

func expired(p *pendingState, now time.Time) bool {
	return !now.Before(p.createdAt.Add(stateTTL))
}
