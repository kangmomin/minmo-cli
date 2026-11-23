package syncapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	// 페어링 코드는 다른 PC 에 옮겨 적는 시간만 주면 되므로 짧게 둔다
	CodeTTL        = 10 * time.Minute
	maxPayloadSize = 1 << 20
)

type Handler struct {
	store *Store
	now   func() time.Time
	cors  []string
}

func NewHandler(s *Store, now func() time.Time, corsOrigins []string) http.Handler {
	h := &Handler{store: s, now: now, cors: corsOrigins}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /pairs", h.createPair)
	mux.HandleFunc("POST /pairs/join", h.join)
	mux.HandleFunc("POST /pairs/{id}/code", h.authed(h.reissue))
	mux.HandleFunc("GET /pairs/{id}/state", h.authed(h.getState))
	mux.HandleFunc("PUT /pairs/{id}/state", h.authed(h.putState))
	return h.withCORS(mux)
}

func (h *Handler) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		origin := r.Header.Get("Origin")
		for _, o := range h.cors {
			if o == origin {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
			}
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func (h *Handler) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		// 다른 페어 접근도 존재 여부를 숨기려고 동일하게 401 로 답한다
		if !ok || !h.store.Authorize(r.PathValue("id"), tok) {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

func (h *Handler) createPair(w http.ResponseWriter, r *http.Request) {
	nowMs := h.now().UnixMilli()
	id, code, tok, err := h.store.CreatePair(nowMs, CodeTTL.Milliseconds())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"pairId": id, "pairCode": code, "token": tok, "codeExpiresAt": nowMs + CodeTTL.Milliseconds(),
	})
}

func (h *Handler) join(w http.ResponseWriter, r *http.Request) {
	var in struct {
		PairCode string `json:"pairCode"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in); err != nil || in.PairCode == "" {
		writeErr(w, http.StatusBadRequest, "invalid_request")
		return
	}
	id, tok, err := h.store.Join(in.PairCode, h.now().UnixMilli())
	if errors.Is(err, ErrNotFound) {
		writeErr(w, http.StatusNotFound, "invalid_code")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"pairId": id, "token": tok})
}

func (h *Handler) reissue(w http.ResponseWriter, r *http.Request) {
	nowMs := h.now().UnixMilli()
	code, err := h.store.ReissueCode(r.PathValue("id"), nowMs, CodeTTL.Milliseconds())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"pairCode": code, "codeExpiresAt": nowMs + CodeTTL.Milliseconds()})
}

func (h *Handler) getState(w http.ResponseWriter, r *http.Request) {
	st, err := h.store.Get(r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, stateBody(st))
}

func stateBody(st State) map[string]any {
	return map[string]any{"rev": st.Rev, "payload": json.RawMessage(st.Payload), "updatedAt": st.UpdatedAt}
}

func (h *Handler) putState(w http.ResponseWriter, r *http.Request) {
	var in struct {
		BaseRev int64           `json:"baseRev"`
		Payload json.RawMessage `json:"payload"`
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxPayloadSize+1))
	if err != nil || len(body) > maxPayloadSize {
		writeErr(w, http.StatusRequestEntityTooLarge, "payload_too_large")
		return
	}
	if err := json.Unmarshal(body, &in); err != nil || len(in.Payload) == 0 || in.Payload[0] != '{' || in.BaseRev < 0 {
		writeErr(w, http.StatusBadRequest, "invalid_request")
		return
	}
	st, err := h.store.Put(r.PathValue("id"), in.BaseRev, string(in.Payload), h.now().UnixMilli())
	if errors.Is(err, ErrConflict) {
		b := stateBody(st)
		b["error"] = "conflict"
		writeJSON(w, http.StatusConflict, b)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, stateBody(st))
}
