// Package timefmt 는 DB 의 epoch ms 와 API 의 고정 포맷 시각 문자열(`YYYY-MM-DDTHH:MM:SS.mmmZ`, UTC)을 변환한다.
//
// Phase 6.1 Red 스텁: 시그니처만 고정한다. 실제 구현은 Phase 6.2.
package timefmt

import "errors"

// FormatMs 는 epoch ms 를 `2006-01-02T15:04:05.000Z` 형식(UTC)으로 변환한다.
func FormatMs(ms int64) string {
	return ""
}

// ParseMs 는 고정 포맷 문자열만 epoch ms 로 변환한다. 그 외 형식은 오류.
func ParseMs(s string) (int64, error) {
	return 0, errors.New("not implemented")
}
