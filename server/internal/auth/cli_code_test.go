package auth_test

import (
	"regexp"
	"testing"
	"time"

	"github.com/kangmomin/minmo-cli/server/internal/auth"
)

func TestCLICode_IssueTake(t *testing.T) {
	c := &clock{now: time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)}
	s := auth.NewCLICodeStore(c.Now)
	code, exp, err := s.Issue("u1")
	if err != nil || !regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$`).MatchString(code) {
		t.Fatalf("Issue = %q %v", code, err)
	}
	if !exp.Equal(c.now.Add(auth.CLICodeTTL)) {
		t.Errorf("expiresAt %v", exp)
	}
	// 소문자·공백·하이픈 없이 입력해도 같은 코드
	lower := " " + string([]rune(code)[0:4]) + string([]rune(code)[5:]) + " "
	if uid, ok := s.Take(toLower(lower)); !ok || uid != "u1" {
		t.Fatalf("Take = %q %v", uid, ok)
	}
	if _, ok := s.Take(code); ok {
		t.Error("1회용이어야 한다")
	}
}

func TestCLICode_ReissueAndExpiry(t *testing.T) {
	c := &clock{now: time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)}
	s := auth.NewCLICodeStore(c.Now)
	first, _, _ := s.Issue("u1")
	second, _, _ := s.Issue("u1")
	if _, ok := s.Take(first); ok {
		t.Error("새로 발급하면 이전 코드는 무효")
	}
	c.now = c.now.Add(auth.CLICodeTTL)
	if _, ok := s.Take(second); ok {
		t.Error("10분이 지나면 만료")
	}
}

func TestCLICode_FailureLockout(t *testing.T) {
	c := &clock{now: time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)}
	s := auth.NewCLICodeStore(c.Now)
	code, _, _ := s.Issue("u1")
	for i := 0; i < 10; i++ {
		s.Take("ZZZZ-ZZZZ")
	}
	if _, ok := s.Take(code); ok {
		t.Error("누적 실패 10회 뒤에는 대기 중인 코드를 모두 무효로 한다")
	}
}

func TestNormalizeCLICode(t *testing.T) {
	for in, want := range map[string]string{"abcd-efgh": "ABCDEFGH", "il0o 1234": "11001234"} {
		if got, ok := auth.NormalizeCLICode(in); !ok || got != want {
			t.Errorf("%q → %q %v, want %q", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "ABC", "ABCDEFGHJ", "ABCD-EFG!", "UUUU-UUUU"} {
		if _, ok := auth.NormalizeCLICode(bad); ok {
			t.Errorf("%q 는 거부", bad)
		}
	}
}

func toLower(s string) string {
	out := []rune(s)
	for i, r := range out {
		if r >= 'A' && r <= 'Z' {
			out[i] = r + 32
		}
	}
	return string(out)
}
