package githubmock_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kangmomin/minmo-cli/server/internal/githubmock"
)

func get(t *testing.T, srv *httptest.Server, path, token string) (int, any) {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var v any
	_ = json.NewDecoder(res.Body).Decode(&v)
	return res.StatusCode, v
}

func TestRepoRoutes(t *testing.T) {
	srv := httptest.NewServer(githubmock.NewHandler())
	defer srv.Close()
	if code, _ := get(t, srv, "/user/orgs", ""); code != 401 {
		t.Errorf("토큰 없으면 401: %d", code)
	}
	_, orgs := get(t, srv, "/user/orgs?per_page=100&page=1", githubmock.TokenOK)
	if len(orgs.([]any)) != 1 {
		t.Errorf("orgs %v", orgs)
	}
	_, page2 := get(t, srv, "/orgs/acme/repos?per_page=100&page=2", githubmock.TokenOK)
	if len(page2.([]any)) != 0 {
		t.Errorf("2쪽은 비어야 한다 %v", page2)
	}
	_, repos := get(t, srv, "/orgs/ACME/repos", githubmock.TokenOK)
	if len(repos.([]any)) != 2 {
		t.Errorf("acme repos %v", repos)
	}
	_, issues := get(t, srv, "/repos/acme/widgets/issues?state=all", githubmock.TokenOK)
	if len(issues.([]any)) != 3 {
		t.Errorf("issues %v", issues)
	}
	if code, _ := get(t, srv, "/repos/acme/widgets/issues/99", githubmock.TokenOK); code != 404 {
		t.Errorf("없는 이슈 404: %d", code)
	}
	if code, r := get(t, srv, "/repos/Acme/Widgets", githubmock.TokenOK); code != 200 || r.(map[string]any)["default_branch"] != "main" {
		t.Errorf("repo %d %v", code, r)
	}
}
