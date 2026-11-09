package auth_test

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"regexp"
	"testing"
	"time"

	"github.com/kangmomin/minmo-cli/server/internal/auth"
)

var reVerifier = regexp.MustCompile(`^[A-Za-z0-9\-._~]{43,128}$`)

// CT-01 / F-01: PKCE code_verifier 형식(RFC 7636) · 매 호출 고유
func TestNewVerifier_CT01(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		v, err := auth.NewVerifier()
		if err != nil {
			t.Fatalf("NewVerifier: %v", err)
		}
		if !reVerifier.MatchString(v) {
			t.Errorf("verifier %q: invalid format", v)
		}
		if seen[v] {
			t.Errorf("verifier repeated: %q", v)
		}
		seen[v] = true
	}
}

// CT-01: code_challenge_method=S256 → challenge = base64url(sha256(verifier)), 패딩 없음
func TestChallenge_S256_CT01(t *testing.T) {
	for _, v := range []string{
		"dBjftJeZ4CVP-mB92K27uhbUJU1p1r7wW1gFWFOEjXk",
		"abcdefghijklmnopqrstuvwxyz0123456789-._~ABCDEFG",
	} {
		sum := sha256.Sum256([]byte(v))
		want := base64.RawURLEncoding.EncodeToString(sum[:])
		if got := auth.Challenge(v); got != want {
			t.Errorf("Challenge(%q) = %q, want %q", v, got, want)
		}
	}
}

type clock struct{ now time.Time }

func (c *clock) Now() time.Time { return c.now }

// CT-25: state 는 1회 소비 — 두 번째 Take 는 실패
func TestStateStore_SingleUse_CT25(t *testing.T) {
	c := &clock{now: time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)}
	s := auth.NewStateStore(c.Now)
	s.Put("st-1", "ver-1")
	v, ok := s.Take("st-1")
	if !ok || v != "ver-1" {
		t.Fatalf("first Take = (%q,%v), want (ver-1,true)", v, ok)
	}
	if _, ok := s.Take("st-1"); ok {
		t.Errorf("second Take succeeded, want invalid_state")
	}
	if _, ok := s.Take("unknown"); ok {
		t.Errorf("unknown state accepted")
	}
}

// EC-04 / CT-03: state TTL 10분 — 경과 후 만료
func TestStateStore_TTL_EC04(t *testing.T) {
	c := &clock{now: time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)}
	s := auth.NewStateStore(c.Now)
	s.Put("fresh", "v1")
	s.Put("stale", "v2")
	c.now = c.now.Add(9*time.Minute + 59*time.Second)
	if v, ok := s.Take("fresh"); !ok || v != "v1" {
		t.Errorf("within TTL: Take = (%q,%v)", v, ok)
	}
	c.now = c.now.Add(2 * time.Second) // 10분 1초 경과
	if _, ok := s.Take("stale"); ok {
		t.Errorf("expired state accepted")
	}
}

// F-01(E1 pending 상한 1,000): 초과 시 최고령 state 제거, 나머지는 유지
func TestStateStore_Cap_F01(t *testing.T) {
	c := &clock{now: time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)}
	s := auth.NewStateStore(c.Now)
	for i := 0; i < 1001; i++ {
		s.Put(fmt.Sprintf("st-%04d", i), fmt.Sprintf("v-%04d", i))
		c.now = c.now.Add(time.Millisecond)
	}
	if _, ok := s.Take("st-0000"); ok {
		t.Errorf("oldest state must be evicted beyond cap 1000")
	}
	for _, k := range []string{"st-0001", "st-0500", "st-1000"} {
		if _, ok := s.Take(k); !ok {
			t.Errorf("%s evicted, want kept", k)
		}
	}
}
