# minmo

GitHub 조직 > 저장소 > 이슈를 트리로 보여 주고, 이슈를 열면 설정(전역 → 조직 → 프로젝트 상속)에 따라
브랜치·git worktree 를 준비하고 생성 후 스크립트를 실행한 뒤, 그 안에서 터미널·커밋·PR·메모를 한 화면에서
처리하는 개인 개발 워크플로우 도구다. 메모·설정은 Go 서버(SQLite)에 저장해 이후 모바일과 공유한다.

현재 범위는 **Phase 1**(로컬 Go 서버 + Tauri 데스크탑)이다. 상세 요구사항은
[`docs/specs/20261109-minmo-issue-worktree-workspace-spec.md`](docs/specs/20261109-minmo-issue-worktree-workspace-spec.md) 참고.

## 모노레포 구조

| 경로 | 내용 |
|------|------|
| `server/` | Go API 서버(`net/http` + SQLite). 단일 Go 모듈 `github.com/kangmomin/minmo-cli/server` — 루트에 `go.mod` 가 없으므로 Go 명령은 `cd server` 후 실행 |
| `server/cmd/minmo-server` | API 서버 진입점 |
| `server/cmd/githubmock` | E2E 전용 GitHub OAuth/API mock 서버 |
| `desktop/` | Tauri 2 + React/TS 데스크탑 앱 |
| `packages/api-client/` | 공유 TS 타입·API 클라이언트·템플릿 치환(`@minmo/api-client`) |
| `contracts/fixtures/` | 서버·클라이언트가 함께 읽는 API 계약 fixture |
| `mobile/` | Phase 3 RN 앱 자리 |
| `docs/specs/` | 기능 Spec |

## 서버

### 요구 사항

- Go 1.26 이상 (cgo 불필요 — 순수 Go SQLite 드라이버 `modernc.org/sqlite`)

### 서버 env

| 변수 | 기본 | 비고 |
|------|------|------|
| `MINMO_LISTEN` | `127.0.0.1:8787` | 비loopback 바인딩은 `MINMO_ALLOW_NON_LOOPBACK=1` 없으면 기동 거부 |
| `MINMO_ALLOW_NON_LOOPBACK` | (없음) | `1` 이면 `0.0.0.0` 등 외부 바인딩 허용 |
| `MINMO_PUBLIC_URL` | `http://127.0.0.1:8787` | OAuth `redirect_uri = {PUBLIC_URL}/auth/github/callback` |
| `MINMO_DB_PATH` | `./minmo.db` | SQLite 파일 경로(WAL). 시작 시 마이그레이션 자동 적용 |
| `MINMO_TOKEN_KEY` | **(필수)** | base64 32바이트, GitHub access token AES-256-GCM 암호화 키. 없으면 기동 실패 |
| `MINMO_GITHUB_CLIENT_ID` / `MINMO_GITHUB_CLIENT_SECRET` | (없음) | 없으면 `POST /auth/github/start` → 503 `github_oauth_not_configured` |
| `MINMO_GITHUB_OAUTH_BASE` / `MINMO_GITHUB_API_BASE` | `https://github.com` / `https://api.github.com` | E2E 는 githubmock 주소로 치환 |
| `MINMO_DEEP_LINK` | `minmo://auth` | 로그인 성공·실패 딥링크 접두 |
| `MINMO_CORS_ORIGINS` | `http://localhost:1420,tauri://localhost,http://tauri.localhost,https://tauri.localhost` | 쉼표 구분 |

> `MINMO_TOKEN_KEY` 를 바꾸면 저장된 GitHub 토큰을 복호화할 수 없어 `/me/github-token` 이 500 이 된다. 이 경우 다시 로그인하면 새 키로 저장된다.

### `MINMO_TOKEN_KEY` 생성

```bash
# macOS / Linux / Git Bash
openssl rand -base64 32
```

```powershell
# Windows PowerShell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

표준·URL-safe base64 모두(패딩 유무 무관) 허용하며, 디코딩 결과는 정확히 32바이트여야 한다.

### GitHub OAuth App 등록

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
2. 입력
   - Application name: `minmo (local)` 등 임의
   - Homepage URL: `http://127.0.0.1:8787`
   - **Authorization callback URL: `http://127.0.0.1:8787/auth/github/callback`**
     (`MINMO_PUBLIC_URL` 을 바꿨다면 `{MINMO_PUBLIC_URL}/auth/github/callback`)
3. 등록 후 **Client ID** 를 `MINMO_GITHUB_CLIENT_ID` 로, **Generate a new client secret** 으로 만든 값을
   `MINMO_GITHUB_CLIENT_SECRET` 으로 설정한다.
4. 로그인은 PKCE(S256)를 쓰며 요청 scope 는 `repo read:org read:user` 다. 조직 저장소가 보이지 않으면
   GitHub 의 해당 조직 **Third-party access** 에서 이 OAuth App 을 승인한다.

### 로컬 실행

```bash
cd server
export MINMO_TOKEN_KEY="$(openssl rand -base64 32)"   # 재시작해도 같은 값을 쓰도록 보관
export MINMO_GITHUB_CLIENT_ID=<client id>
export MINMO_GITHUB_CLIENT_SECRET=<client secret>
go run ./cmd/minmo-server
curl http://127.0.0.1:8787/healthz   # {"status":"ok"}
```

```powershell
cd server
$env:MINMO_TOKEN_KEY = "<생성한 키>"
$env:MINMO_GITHUB_CLIENT_ID = "<client id>"
$env:MINMO_GITHUB_CLIENT_SECRET = "<client secret>"
go run ./cmd/minmo-server
```

### 테스트

```bash
cd server
go build ./... && go vet ./... && go test ./...
```

`server/internal/httpapi/contract_test.go` 는 `contracts/fixtures/` 를 읽는 공용 계약 테스트다.

### E2E (githubmock)

실제 GitHub 대신 `cmd/githubmock`(기본 `127.0.0.1:8790`, env `GITHUBMOCK_LISTEN`)을 띄워 OAuth 흐름을 재현한다.

| mock code | 결과 |
|-----------|------|
| `mock-code-ok` | `gho_mock_token` → 사용자 `octocat`(id 583231) |
| `mock-code-user2` | `gho_mock_token2` → 사용자 `hubot`(id 480938, avatar 없음) |
| `mock-code-5xx` | 토큰 교환 HTTP 500 → 콜백 502 `github_unavailable` |
| 그 외 | `bad_verification_code` → 콜백 400 `invalid_code` |
| authorize 로 발급된 code | `code_verifier` 의 S256 이 `code_challenge` 와 같을 때만 `gho_mock_token`(1회용) |

```bash
# 1) mock → 2) 서버 순서로 기동
(cd server && go run ./cmd/githubmock) &
(cd server && MINMO_TOKEN_KEY="$(openssl rand -base64 32)" \
  MINMO_GITHUB_CLIENT_ID=e2e MINMO_GITHUB_CLIENT_SECRET=e2e \
  MINMO_GITHUB_OAUTH_BASE=http://127.0.0.1:8790 MINMO_GITHUB_API_BASE=http://127.0.0.1:8790 \
  MINMO_DB_PATH=/tmp/minmo-e2e.db go run ./cmd/minmo-server) &

# 3) 로그인: start → callback(302 minmo://auth?session=…&state=…)
STATE=$(curl -s -X POST http://127.0.0.1:8787/auth/github/start | sed -E 's/.*"state":"([^"]+)".*/\1/')
curl -s -D - -o /dev/null "http://127.0.0.1:8787/auth/github/callback?code=mock-code-ok&state=$STATE" | grep -i '^location'
```

`curl -w '%{redirect_url}'` 은 커스텀 스킴 URL 을 `minmo://auth/?…` 로 정규화해 보여 주므로, 정확한 `Location` 은 `-D -` 로 확인한다.
`go run` 은 자식 프로세스를 따로 띄우므로 종료 시 해당 프로세스(`minmo-server`, `githubmock`)까지 정리한다.

## 데스크탑

```bash
npm ci
npm run typecheck && npm test
npm run e2e        # Playwright(Tauri mock)
```

Tauri 네이티브 빌드는 Rust(cargo)가 필요하다. 서버 주소는 `VITE_MINMO_SERVER`(기본 `http://127.0.0.1:8787`).

## Windows 안내

- worktree 경로가 길어질 수 있으므로 `git config --global core.longpaths true` 를 권장한다(260자 경로 제한 회피).
- 생성 후 스크립트(`postCreateScript`)는 Windows 에서 PowerShell(`powershell -NoProfile -ExecutionPolicy Bypass -File <임시>.ps1`)로 실행된다.
  **PowerShell 은 스크립트 중간의 네이티브 명령(`git`, `npm` 등)이 실패해도 다음 줄을 계속 실행한다.** 실행기는 마지막에
  `if ($LASTEXITCODE) { exit $LASTEXITCODE }` 에필로그로 마지막 네이티브 명령의 종료 코드만 전달하므로, 중간 실패에서 멈춰야 하면
  스크립트 안에서 직접 검사한다.

  ```powershell
  npm ci
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  npm run build
  ```

- macOS/Linux 는 `sh`(`set -e`)로 실행되어 첫 실패에서 멈춘다.
