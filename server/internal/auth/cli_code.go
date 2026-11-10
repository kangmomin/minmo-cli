package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"
	"time"
)

const (
	// CLICodeTTL 은 원격 CLI 로그인 코드의 유효 시간이다.
	CLICodeTTL = 10 * time.Minute
	// cliCodeMaxFailures 는 누적 실패 상한이다. 넘으면 대기 중인 코드를 모두 무효로 해 추측 공격 창을 닫는다.
	cliCodeMaxFailures = 10
	cliCodeCap         = 1000
	cliCodeLen         = 8
)

// Crockford base32 — 사람이 옮겨 적기 쉬운 문자만(I·L·O·U 없음).
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

type pendingCLICode struct {
	userID    string
	expiresAt time.Time
}

// CLICodeStore 는 데스크탑이 발급한 1회용 CLI 로그인 코드를 메모리에 보관한다.
// 원문 대신 해시만 저장하고, 사용자당 활성 코드는 1개(새로 발급하면 이전 코드 무효)다.
// 단일 서버 인스턴스 전제 — 재시작하면 대기 중인 코드는 사라진다.
type CLICodeStore struct {
	mu       sync.Mutex
	now      func() time.Time
	byHash   map[string]pendingCLICode
	byUser   map[string]string // userID → hash
	failures int
}

// NewCLICodeStore 는 now 주입 시계를 쓰는 저장소를 만든다.
func NewCLICodeStore(now func() time.Time) *CLICodeStore {
	return &CLICodeStore{now: now, byHash: map[string]pendingCLICode{}, byUser: map[string]string{}}
}

// Issue 는 userID 의 새 코드("ABCD-EFGH")와 만료 시각을 만든다.
func (s *CLICodeStore) Issue(userID string) (code string, expiresAt time.Time, err error) {
	raw, err := randomCrockford(cliCodeLen)
	if err != nil {
		return "", time.Time{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.purgeExpired(now)
	if old, ok := s.byUser[userID]; ok {
		delete(s.byHash, old)
	}
	if len(s.byHash) >= cliCodeCap {
		// 상한은 사용자 수만큼만 차므로 정상 사용에서는 닿지 않는다 — 넘치면 전부 비운다
		s.byHash = map[string]pendingCLICode{}
		s.byUser = map[string]string{}
	}
	h := hashCLICode(raw)
	expiresAt = now.Add(CLICodeTTL)
	s.byHash[h] = pendingCLICode{userID: userID, expiresAt: expiresAt}
	s.byUser[userID] = h
	return raw[:4] + "-" + raw[4:], expiresAt, nil
}

// Take 는 코드를 1회 소비해 userID 를 돌려준다. 없음·만료·이미 사용됨이면 ok=false.
func (s *CLICodeStore) Take(code string) (userID string, ok bool) {
	norm, valid := NormalizeCLICode(code)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.purgeExpired(now)
	h := hashCLICode(norm)
	p, found := s.byHash[h]
	if !valid || !found {
		s.failures++
		if s.failures >= cliCodeMaxFailures {
			s.byHash = map[string]pendingCLICode{}
			s.byUser = map[string]string{}
			s.failures = 0
		}
		return "", false
	}
	delete(s.byHash, h)
	delete(s.byUser, p.userID)
	return p.userID, true
}

// NormalizeCLICode 는 대소문자·하이픈·공백을 정리하고 헷갈리는 문자(I·L→1, O→0)를 바로잡는다.
func NormalizeCLICode(code string) (string, bool) {
	var b strings.Builder
	for _, r := range strings.ToUpper(code) {
		switch {
		case r == '-' || r == ' ':
			continue
		case r == 'I' || r == 'L':
			r = '1'
		case r == 'O':
			r = '0'
		}
		if !strings.ContainsRune(crockford, r) {
			return "", false
		}
		b.WriteRune(r)
	}
	out := b.String()
	return out, len(out) == cliCodeLen
}

func (s *CLICodeStore) purgeExpired(now time.Time) {
	for h, p := range s.byHash {
		if !now.Before(p.expiresAt) {
			delete(s.byHash, h)
			if s.byUser[p.userID] == h {
				delete(s.byUser, p.userID)
			}
		}
	}
}

func hashCLICode(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

func randomCrockford(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, n)
	for i, v := range b {
		out[i] = crockford[int(v)%len(crockford)] // 256 은 32 의 배수라 치우침 없음
	}
	return string(out), nil
}
