package httpapi_test

import (
	"strings"
	"testing"

	"github.com/kangmomin/minmo-cli/server/internal/githubmock"
	"github.com/kangmomin/minmo-cli/server/internal/pairsync"
	"github.com/kangmomin/minmo-cli/server/internal/testutil"
)

// 메인 서버도 server-sync 와 같은 페어 경로를 낸다 — 배포된 서버 주소로 페어링할 수 있게
func TestPairs_JoinAndSync(t *testing.T) {
	s := testutil.NewTestServer(t)
	st, p := s.DoJSON("POST", "/pairs", "", nil)
	if st != 201 {
		t.Fatalf("create=%d %v", st, p)
	}
	id, code, tokA := p["pairId"].(string), p["pairCode"].(string), p["token"].(string)

	// 코드는 1회용
	st, j := s.DoJSON("POST", "/pairs/join", "", `{"pairCode":"`+code+`"}`)
	if st != 200 {
		t.Fatalf("join=%d %v", st, j)
	}
	tokB := j["token"].(string)
	if st, _ := s.DoJSON("POST", "/pairs/join", "", `{"pairCode":"`+code+`"}`); st != 404 {
		t.Fatalf("재사용 join=%d, want 404", st)
	}

	// A 가 저장 → B 가 읽음
	if st, r := s.DoJSON("PUT", "/pairs/"+id+"/state", tokA, `{"baseRev":0,"payload":{"a":1}}`); st != 200 || r["rev"].(float64) != 1 {
		t.Fatalf("put=%d %v", st, r)
	}
	st, g := s.DoJSON("GET", "/pairs/"+id+"/state", tokB, nil)
	if st != 200 || g["payload"].(map[string]any)["a"].(float64) != 1 {
		t.Fatalf("get=%d %v", st, g)
	}

	// 오래된 baseRev 는 409 + 현재 상태
	st, c := s.DoJSON("PUT", "/pairs/"+id+"/state", tokB, `{"baseRev":0,"payload":{"b":2}}`)
	if st != 409 || c["rev"].(float64) != 1 {
		t.Fatalf("conflict=%d %v", st, c)
	}
}

func TestPairs_CodeExpiryAndAuth(t *testing.T) {
	s := testutil.NewTestServer(t)
	_, p := s.DoJSON("POST", "/pairs", "", nil)
	id, code, tok := p["pairId"].(string), p["pairCode"].(string), p["token"].(string)

	if st, _ := s.DoJSON("GET", "/pairs/"+id+"/state", "", nil); st != 401 {
		t.Fatalf("토큰 없음=%d", st)
	}
	if st, _ := s.DoJSON("GET", "/pairs/"+id+"/state", "wrong", nil); st != 401 {
		t.Fatalf("잘못된 토큰=%d", st)
	}
	// 메인 서버의 로그인 세션 토큰으로는 페어에 접근하지 못한다
	session, _ := s.Login(githubmock.CodeOK)
	if st, _ := s.DoJSON("GET", "/pairs/"+id+"/state", session, nil); st != 401 {
		t.Fatalf("세션 토큰=%d, want 401", st)
	}

	s.Advance(pairsync.CodeTTL + 1)
	if st, _ := s.DoJSON("POST", "/pairs/join", "", `{"pairCode":"`+code+`"}`); st != 404 {
		t.Fatalf("만료 코드=%d, want 404", st)
	}
	// 재발급한 새 코드는 사용 가능
	_, r := s.DoJSON("POST", "/pairs/"+id+"/code", tok, nil)
	if st, _ := s.DoJSON("POST", "/pairs/join", "", `{"pairCode":"`+r["pairCode"].(string)+`"}`); st != 200 {
		t.Fatalf("재발급 코드 join=%d", st)
	}
}

func TestPairs_CodeWithoutHyphenAndPayloadShape(t *testing.T) {
	s := testutil.NewTestServer(t)
	_, p := s.DoJSON("POST", "/pairs", "", nil)
	id, tok := p["pairId"].(string), p["token"].(string)
	plain := strings.ToLower(strings.ReplaceAll(p["pairCode"].(string), "-", ""))
	if st, _ := s.DoJSON("POST", "/pairs/join", "", `{"pairCode":"`+plain+`"}`); st != 200 {
		t.Fatalf("하이픈 없는 코드 join=%d", st)
	}
	for _, bad := range []string{`{"baseRev":0,"payload":null}`, `{"baseRev":0,"payload":[1]}`, `{"baseRev":0,"payload":"x"}`} {
		if st, _ := s.DoJSON("PUT", "/pairs/"+id+"/state", tok, bad); st != 400 {
			t.Fatalf("%s=%d, want 400", bad, st)
		}
	}
}

// 데스크탑 webview 가 페어 경로를 부를 수 있게 메인 서버의 CORS 가 그대로 적용된다
func TestPairs_CORS(t *testing.T) {
	s := testutil.NewTestServer(t)
	origin := map[string]string{"Origin": "http://tauri.localhost"}
	resp, _ := s.Do("OPTIONS", "/pairs/join", "", nil, map[string]string{
		"Origin": "http://tauri.localhost", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type",
	})
	if resp.StatusCode != 204 || resp.Header.Get("Access-Control-Allow-Origin") != "http://tauri.localhost" {
		t.Fatalf("preflight=%d allow-origin=%q", resp.StatusCode, resp.Header.Get("Access-Control-Allow-Origin"))
	}
	resp, _ = s.Do("POST", "/pairs", "", nil, origin)
	if resp.StatusCode != 201 || resp.Header.Get("Access-Control-Allow-Origin") != "http://tauri.localhost" {
		t.Fatalf("create=%d allow-origin=%q", resp.StatusCode, resp.Header.Get("Access-Control-Allow-Origin"))
	}
}
