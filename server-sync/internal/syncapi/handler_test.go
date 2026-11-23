package syncapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type env struct {
	srv *httptest.Server
	now *time.Time
}

func newEnv(t *testing.T) *env {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	now := time.UnixMilli(1_700_000_000_000)
	e := &env{now: &now}
	e.srv = httptest.NewServer(NewHandler(s, func() time.Time { return *e.now }, nil))
	t.Cleanup(e.srv.Close)
	return e
}

func (e *env) do(t *testing.T, method, path, token, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, e.srv.URL+path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func TestPairJoinAndSync(t *testing.T) {
	e := newEnv(t)
	st, p := e.do(t, "POST", "/pairs", "", "")
	if st != 201 {
		t.Fatalf("create=%d", st)
	}
	id, code, tokA := p["pairId"].(string), p["pairCode"].(string), p["token"].(string)

	// 코드는 1회용
	st, j := e.do(t, "POST", "/pairs/join", "", `{"pairCode":"`+code+`"}`)
	if st != 200 {
		t.Fatalf("join=%d", st)
	}
	tokB := j["token"].(string)
	if st, _ := e.do(t, "POST", "/pairs/join", "", `{"pairCode":"`+code+`"}`); st != 404 {
		t.Fatalf("재사용 join=%d, want 404", st)
	}

	// A 가 저장 → B 가 읽음
	if st, r := e.do(t, "PUT", "/pairs/"+id+"/state", tokA, `{"baseRev":0,"payload":{"a":1}}`); st != 200 || r["rev"].(float64) != 1 {
		t.Fatalf("put=%d %v", st, r)
	}
	st, g := e.do(t, "GET", "/pairs/"+id+"/state", tokB, "")
	if st != 200 || g["payload"].(map[string]any)["a"].(float64) != 1 {
		t.Fatalf("get=%d %v", st, g)
	}

	// 오래된 baseRev 는 409 + 현재 상태
	st, c := e.do(t, "PUT", "/pairs/"+id+"/state", tokB, `{"baseRev":0,"payload":{"b":2}}`)
	if st != 409 || c["rev"].(float64) != 1 {
		t.Fatalf("conflict=%d %v", st, c)
	}
}

func TestCodeExpiryAndAuth(t *testing.T) {
	e := newEnv(t)
	_, p := e.do(t, "POST", "/pairs", "", "")
	id, code, tok := p["pairId"].(string), p["pairCode"].(string), p["token"].(string)

	if st, _ := e.do(t, "GET", "/pairs/"+id+"/state", "", ""); st != 401 {
		t.Fatalf("토큰 없음=%d", st)
	}
	if st, _ := e.do(t, "GET", "/pairs/"+id+"/state", "wrong", ""); st != 401 {
		t.Fatalf("잘못된 토큰=%d", st)
	}

	*e.now = e.now.Add(CodeTTL + time.Second)
	if st, _ := e.do(t, "POST", "/pairs/join", "", `{"pairCode":"`+code+`"}`); st != 404 {
		t.Fatalf("만료 코드=%d, want 404", st)
	}
	// 재발급한 새 코드는 사용 가능
	_, r := e.do(t, "POST", "/pairs/"+id+"/code", tok, "")
	if st, _ := e.do(t, "POST", "/pairs/join", "", `{"pairCode":"`+r["pairCode"].(string)+`"}`); st != 200 {
		t.Fatalf("재발급 코드 join=%d", st)
	}
}

func TestCodeWithoutHyphenAndPayloadShape(t *testing.T) {
	e := newEnv(t)
	_, p := e.do(t, "POST", "/pairs", "", "")
	id, tok := p["pairId"].(string), p["token"].(string)
	plain := strings.ToLower(strings.ReplaceAll(p["pairCode"].(string), "-", ""))
	if st, _ := e.do(t, "POST", "/pairs/join", "", `{"pairCode":"`+plain+`"}`); st != 200 {
		t.Fatalf("하이픈 없는 코드 join=%d", st)
	}
	for _, bad := range []string{`{"baseRev":0,"payload":null}`, `{"baseRev":0,"payload":[1]}`, `{"baseRev":0,"payload":"x"}`} {
		if st, _ := e.do(t, "PUT", "/pairs/"+id+"/state", tok, bad); st != 400 {
			t.Fatalf("%s=%d, want 400", bad, st)
		}
	}
}
