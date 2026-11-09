package timefmt

import (
	"testing"
	"time"
)

// CT-14: updatedAt 형식 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$` (UTC 밀리초 고정)
func TestFormatMs_CT14(t *testing.T) {
	cases := []struct {
		ms   int64
		want string
	}{
		{0, "1970-01-01T00:00:00.000Z"},
		{1, "1970-01-01T00:00:00.001Z"},
		{time.Date(2026, 11, 9, 12, 0, 0, 123_000_000, time.UTC).UnixMilli(), "2026-11-09T12:00:00.123Z"},
		{time.Date(2026, 11, 9, 23, 59, 59, 0, time.UTC).UnixMilli(), "2026-11-09T23:59:59.000Z"},
	}
	for _, c := range cases {
		if got := FormatMs(c.ms); got != c.want {
			t.Errorf("FormatMs(%d) = %q, want %q", c.ms, got, c.want)
		}
	}
}

// CT-15·CT-31: 고정 포맷만 수용 → 정수 동등 = 문자열 동등 (왕복 보존)
func TestParseMs_RoundTrip_CT15_CT31(t *testing.T) {
	for _, ms := range []int64{0, 1, 999, 1_794_225_600_123, 1_794_225_600_124} {
		s := FormatMs(ms)
		got, err := ParseMs(s)
		if err != nil {
			t.Errorf("ParseMs(%q): %v", s, err)
			continue
		}
		if got != ms {
			t.Errorf("ParseMs(FormatMs(%d)) = %d", ms, got)
		}
	}
}

// CT-15(invalid_base_updated_at 근거): 고정 포맷 외 형식은 모두 거부
func TestParseMs_RejectsNonCanonical_CT15(t *testing.T) {
	for _, s := range []string{
		"",
		"2026-11-09T12:00:00Z",          // 밀리초 없음
		"2026-11-09T12:00:00.12Z",       // 2자리
		"2026-11-09T12:00:00.1234Z",     // 4자리
		"2026-11-09T12:00:00.123+00:00", // 오프셋 표기
		"2026-11-09T12:00:00.123",       // Z 없음
		"2026-11-09 12:00:00.123Z",      // 구분자
		"2026-13-09T12:00:00.123Z",      // 잘못된 월
		"1794225600123",                 // epoch 숫자
	} {
		if _, err := ParseMs(s); err == nil {
			t.Errorf("ParseMs(%q) accepted, want error", s)
		}
	}
}
