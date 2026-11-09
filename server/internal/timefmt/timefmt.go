// Package timefmt 는 DB 의 epoch ms 와 API 의 고정 포맷 시각 문자열(`YYYY-MM-DDTHH:MM:SS.mmmZ`, UTC)을 변환한다.
package timefmt

import (
	"errors"
	"time"
)

// Layout 은 API 경계의 유일한 시각 포맷이다(UTC, 밀리초 3자리 고정).
const Layout = "2006-01-02T15:04:05.000Z"

var errNonCanonical = errors.New("timefmt: not a canonical timestamp")

// FormatMs 는 epoch ms 를 `2006-01-02T15:04:05.000Z` 형식(UTC)으로 변환한다.
func FormatMs(ms int64) string {
	return time.UnixMilli(ms).UTC().Format(Layout)
}

// ParseMs 는 고정 포맷 문자열만 epoch ms 로 변환한다. 그 외 형식은 오류.
//
// 왕복(FormatMs(ParseMs(s)) == s)까지 요구해 "정수 동등 = 문자열 동등"을 보장한다
// — notes baseUpdatedAt 비교가 이 성질에 의존한다.
func ParseMs(s string) (int64, error) {
	if len(s) != len(Layout) {
		return 0, errNonCanonical
	}
	t, err := time.Parse(Layout, s)
	if err != nil {
		return 0, errNonCanonical
	}
	ms := t.UnixMilli()
	if FormatMs(ms) != s {
		return 0, errNonCanonical
	}
	return ms, nil
}
