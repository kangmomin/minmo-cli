package githubmock

import (
	"net/http"
	"strconv"
	"strings"
)

// E2E 용 최소 GitHub REST 목록(원격 CLI·데스크탑 트리 검증). 데이터는 고정이다:
//   - 사용자 octocat(개인 저장소 dotfiles), 조직 acme(저장소 widgets·gadgets)
//   - acme/widgets 이슈: #7 open "Add login", #3 closed "Old bug", #5 는 PR(목록에서 걸러져야 함)
//
// 페이지는 1쪽만 돌려준다(per_page 보다 적으므로 클라이언트가 멈춘다). 토큰은 users 에 있는 것만 받는다.

type mockRepo struct {
	Owner string
	Name  string
}

var (
	mockOrgs  = []string{"acme"}
	mockRepos = []mockRepo{{"octocat", "dotfiles"}, {"acme", "widgets"}, {"acme", "gadgets"}}
	// pull_request 가 있으면 PR
	mockIssues = map[string][]map[string]any{
		"acme/widgets": {
			{"number": 7, "title": "Add login", "state": "open", "html_url": "https://github.com/acme/widgets/issues/7"},
			{"number": 5, "title": "A pull request", "state": "open", "html_url": "https://github.com/acme/widgets/pull/5", "pull_request": map[string]any{}},
			{"number": 3, "title": "Old bug", "state": "closed", "html_url": "https://github.com/acme/widgets/issues/3"},
		},
	}
)

func registerRepoRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /user/orgs", authed(func(w http.ResponseWriter, r *http.Request) {
		out := []map[string]any{}
		for _, o := range mockOrgs {
			out = append(out, map[string]any{"login": o, "avatar_url": nil})
		}
		writeJSON(w, http.StatusOK, pageOne(r, out))
	}))
	mux.HandleFunc("GET /user/repos", authed(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, pageOne(r, reposOf("octocat")))
	}))
	mux.HandleFunc("GET /orgs/{org}/repos", authed(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, pageOne(r, reposOf(r.PathValue("org"))))
	}))
	mux.HandleFunc("GET /repos/{owner}/{repo}", authed(func(w http.ResponseWriter, r *http.Request) {
		for _, x := range mockRepos {
			if strings.EqualFold(x.Owner, r.PathValue("owner")) && strings.EqualFold(x.Name, r.PathValue("repo")) {
				writeJSON(w, http.StatusOK, repoJSON(x))
				return
			}
		}
		notFound(w)
	}))
	mux.HandleFunc("GET /repos/{owner}/{repo}/issues", authed(func(w http.ResponseWriter, r *http.Request) {
		key := strings.ToLower(r.PathValue("owner") + "/" + r.PathValue("repo"))
		list := mockIssues[key]
		if list == nil {
			list = []map[string]any{}
		}
		writeJSON(w, http.StatusOK, pageOne(r, list))
	}))
	mux.HandleFunc("GET /repos/{owner}/{repo}/issues/{n}", authed(func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.PathValue("n"))
		for _, i := range mockIssues[strings.ToLower(r.PathValue("owner")+"/"+r.PathValue("repo"))] {
			if i["number"] == n {
				writeJSON(w, http.StatusOK, i)
				return
			}
		}
		notFound(w)
	}))
}

func reposOf(owner string) []map[string]any {
	out := []map[string]any{}
	for _, x := range mockRepos {
		if strings.EqualFold(x.Owner, owner) {
			out = append(out, repoJSON(x))
		}
	}
	return out
}

func repoJSON(x mockRepo) map[string]any {
	return map[string]any{"name": x.Name, "owner": map[string]any{"login": x.Owner}, "default_branch": "main"}
}

// pageOne 은 page=1 만 내용을 주고 나머지 페이지는 빈 목록이다.
func pageOne[T any](r *http.Request, items []T) []T {
	if p := r.URL.Query().Get("page"); p != "" && p != "1" {
		return []T{}
	}
	return items
}

func notFound(w http.ResponseWriter) {
	writeJSON(w, http.StatusNotFound, map[string]any{"message": "Not Found"})
}

func authed(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "token ")
		if _, ok := users[tok]; !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"message": "Bad credentials"})
			return
		}
		h(w, r)
	}
}
