package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/kangmomin/minmo-cli/server/internal/auth"
)

// 요청 바이트 상한(http.MaxBytesReader). notes 는 JSON 이스케이프 팽창(최대 6배)을 흡수하려고 8 MiB,
// 본문 1 MiB 판정은 디코딩 후 UTF-8 바이트로 별도 수행한다(notes_handler).
const (
	maxRequestBytes      = 1 << 20
	maxNotesRequestBytes = 8 << 20
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// decodeJSON 은 요청 본문을 dst 로 디코드한다. 알 수 없는 키는 무시한다(계약 "JSON 디코드").
// 상한 초과 → 413 payload_too_large, 타입 불일치 → invalid_json{field}, 그 외 구문 오류 → invalid_json.
func decodeJSON(w http.ResponseWriter, r *http.Request, limit int64, dst any) *apiError {
	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit)).Decode(dst)
	if err == nil {
		return nil
	}
	var tooLarge *http.MaxBytesError
	var typeErr *json.UnmarshalTypeError
	switch {
	case errors.As(err, &tooLarge):
		return &apiError{status: http.StatusRequestEntityTooLarge, code: CodePayloadTooLarge}
	case errors.As(err, &typeErr):
		return badRequest(CodeInvalidJSON, typeErr.Field)
	default:
		return badRequest(CodeInvalidJSON, "")
	}
}

// session 은 인증된 요청의 주체다. token 은 E5(로그아웃)에서만 쓴다.
type session struct {
	userID string
	token  string
}

// authed 는 Bearer 세션을 검증한 뒤 h 를 호출한다. 실패는 모두 401 unauthorized(검증 순서 ①).
func (a *api) authed(h func(http.ResponseWriter, *http.Request, session)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerToken(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, CodeUnauthorized, "")
			return
		}
		userID, err := auth.Lookup(r.Context(), a.db, token, a.now())
		if errors.Is(err, auth.ErrInvalidSession) {
			writeError(w, http.StatusUnauthorized, CodeUnauthorized, "")
			return
		}
		if err != nil {
			a.internal(w, r, err)
			return
		}
		h(w, r, session{userID: userID, token: token})
	}
}

func bearerToken(r *http.Request) (string, bool) {
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	token = strings.TrimSpace(token)
	if !ok || !strings.EqualFold(scheme, "Bearer") || token == "" {
		return "", false
	}
	return token, true
}

// internal 은 예기치 못한 오류를 기록하고 500 internal 로 응답한다(원본 오류는 응답에 노출하지 않음).
func (a *api) internal(w http.ResponseWriter, r *http.Request, err error) {
	slog.Error("internal error", "method", r.Method, "path", r.URL.Path, "err", err)
	writeError(w, http.StatusInternalServerError, CodeInternal, "")
}

// cors 는 허용 Origin 만 echo 한다. OPTIONS 는 경로·Origin 과 무관하게 204(허용 시에만 CORS 헤더).
// 미허용 Origin 의 일반 요청도 처리한다 — CORS 는 차단 수단이 아니다.
func cors(origins []string, next http.Handler) http.Handler {
	allowed := make(map[string]bool, len(origins))
	for _, o := range origins {
		allowed[o] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Add("Vary", "Origin")
		origin := r.Header.Get("Origin")
		ok := origin != "" && allowed[origin]
		if ok {
			h.Set("Access-Control-Allow-Origin", origin)
		}
		if r.Method == http.MethodOptions {
			if ok {
				h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				h.Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// noStore 는 모든 응답에 Cache-Control: no-store 를 붙인다(계약 "캐시").
func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// logRequests 는 요청 1건을 slog 로 남긴다. 쿼리(OAuth code·state)는 기록하지 않는다.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		slog.Info("http", "method", r.Method, "path", r.URL.Path, "status", sw.status, "dur_ms", time.Since(start).Milliseconds())
	})
}

// recoverPanics 는 핸들러 panic 을 500 internal JSON 으로 바꾼다.
func recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler {
				panic(v)
			}
			slog.Error("panic", "method", r.Method, "path", r.URL.Path, "panic", v, "stack", string(debug.Stack()))
			writeError(w, http.StatusInternalServerError, CodeInternal, "")
		}()
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// captureWriter 는 ServeMux 내부 404/405 핸들러의 상태 코드만 가로챈다(본문은 버림).
type captureWriter struct {
	header http.Header
	status int
}

func (c *captureWriter) Header() http.Header { return c.header }

func (c *captureWriter) Write(b []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	return len(b), nil
}

func (c *captureWriter) WriteHeader(code int) {
	if c.status == 0 {
		c.status = code
	}
}
