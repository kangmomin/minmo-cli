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
| `packages/core/` | 데스크탑·원격 CLI 공용 도메인 로직 — worktree 서비스·GitHub 클라이언트·보일 저장소 판정(`@minmo/core`) |
| `packages/cli/` | 원격 SSH 관리용 CLI·TUI(`minmo-cli`, bin `minmo`) |
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

트리 상단의 **표시할 저장소** 버튼으로 보일 저장소를 고른다(서버에 저장되어 원격 CLI 와 공유). 로컬 worktree 가 있는 저장소는 빼도 "숨김" 표시와 함께 보인다.

## 원격 CLI (SSH)

원격 서버에 `minmo` CLI 를 설치하고 SSH 로 접속해, 그 서버의 worktree 를 터미널에서 관리한다(TUI + 명령어).
설정·메모·보일 저장소는 이 PC 의 minmo 서버에 있고, 원격 CLI 는 **SSH 역터널**로 그 서버를 쓴다(서버는 계속 `127.0.0.1` 에서만 듣는다).
역터널 없이(다른 기기에서 SSH 로 들어와도) 쓰려면 **로컬 모드**로 바꾼다 — 아래 [서버 모드 / 로컬 모드](#서버-모드--로컬-모드).

### 요구 사항(원격)

- Linux 또는 macOS, Node.js 22.12 이상, git 2.31 이상, tmux(터미널)
- GitHub: `gh auth login` + `gh auth setup-git` 권장(private 저장소 clone). gh 가 없으면 `GITHUB_TOKEN` 또는 서버의 GitHub 토큰으로 REST 를 쓴다(로컬 모드는 서버 토큰을 쓰지 않으므로 gh 나 `GITHUB_TOKEN` 이 꼭 있어야 한다)

### 설치

```bash
# 이 PC(저장소)에서 패키지 만들기 → dist/minmo-cli-<버전>.tgz
npm ci && npm run pack:cli
# 원격에 복사해 설치
scp dist/minmo-cli-*.tgz my-server:
ssh my-server 'npm i -g ./minmo-cli-*.tgz && mkdir -p ~/.minmo'
```

### SSH 설정(이 PC 의 `~/.ssh/config`)

```
Host my-server
  HostName <원격 주소>
  User <사용자>
  RemoteForward /home/<사용자>/.minmo/server.sock 127.0.0.1:8787
```

- TCP 포트 대신 **Unix 소켓**으로 역터널한다 — 원격의 다른 사용자가 포트로 접근하거나, 포트 충돌로 토큰이 엉뚱한 곳으로 가는 일을 막는다. CLI 는 `MINMO_SERVER` 를 명시하지 않으면 소켓만 쓰고(127.0.0.1:8787 로 넘어가지 않음), 소켓 소유자가 자신이 아니면 연결하지 않는다.
- 원격 **sshd_config** 에 `StreamLocalBindUnlink yes` 가 있어야 재접속 때 이전 소켓을 바꿔 쓴다(관리자 설정, 클라이언트 쪽 같은 이름의 옵션은 RemoteForward 에 효과가 없다). 없으면 재접속 전에 원격에서 `rm ~/.minmo/server.sock` — `minmo doctor` 가 남은 소켓을 알려 준다. 같은 이유로 `ExitOnForwardFailure` 는 넣지 않는다(남은 소켓 때문에 접속 자체가 막힌다).
- 원격 sshd 가 `AllowStreamLocalForwarding` 을 허용해야 한다(기본 허용). 원격에 `~/.minmo` 폴더가 먼저 있어야 한다.
- 소켓 대신 다른 주소를 쓰려면 `MINMO_SERVER=http://…`, 소켓 경로는 `MINMO_SOCKET`.

### 로그인

1. 데스크탑 상단 바 **원격 CLI 접속** → **코드 발급**(10분, 1회용)
2. 원격에서 `minmo login ABCD-EFGH` — 이 기기 이름(hostname)으로 세션이 만들어지고, 데스크탑의 같은 다이얼로그에서 확인·끊기 할 수 있다
3. `minmo doctor` 로 터널·로그인·git·gh·tmux 점검

자격 증명은 `~/.config/minmo/credentials.json`(권한 0600), 모드·로컬 값은 `config.json`, worktree 기록·서버 사본은 `state.json` 에 둔다.
CLI 는 시작할 때 서버 계정이 로그인한 계정과 같은지 확인한다(다른 서버로 연결된 터널에 토큰을 보내지 않게).

### 사용

| 명령 | 내용 |
|------|------|
| `minmo` | TUI — 트리(보일 저장소 필터)·상세. `Enter` 준비 · `t` tmux 터미널 · `n` 메모 · `d` 삭제 · `f` 보이기/숨기기 · `a` 숨긴 것 보기 · `s` 설정 · `/` 검색 · `q` 종료 |
| `minmo ls [owner[/repo]] [--all] [--json]` | 저장소·이슈 목록 |
| `minmo open owner/repo#42` | worktree 준비 후 tmux 터미널(`--no-attach` 면 경로만) |
| `minmo rm owner/repo#42 [--yes]` | worktree 삭제 — 그 안의 tmux 터미널·프로세스도 정리 |
| `minmo note owner/repo#42` | 메모를 `$EDITOR` 로 편집(다른 기기와 충돌하면 내 내용을 파일로 보존) |
| `minmo repos [add\|rm\|all\|reset] …` | 보일 저장소(서버 모드는 데스크탑과 공유, 로컬 모드는 이 기기. `owner/*` 는 조직 전체, `reset` 은 로컬 모드에서 서버 사본으로) |
| `minmo config [get\|set] … [--org o\|--project o/r]` | 설정(서버 모드는 데스크탑과 공유, 로컬 모드는 이 기기). 여러 줄 값은 `@파일`, `-` 는 상속(서버)·로컬 값 지움(로컬) |
| `minmo mode [local\|server]` | 모드 보기·바꾸기 |
| `minmo sessions [revoke <id>]` | 로그인된 기기 |

- 터미널은 전용 tmux 서버(`tmux -L minmo`)의 세션이다. 분할은 tmux 기본 키를 쓴다.
- 원격에서는 생성 후 스크립트로 **`postCreateScriptPosix`**(sh)를 실행한다. `postCreateScript` 는 Windows(PowerShell) 용이다.
- 설정의 경로는 기기 간에 공유되므로 `~` 로 시작하게 둔다. 이 OS 에서 쓸 수 없는 경로(예: Linux 에서 `C:\…`)면 clone 하지 않고 알려 준다.
- worktree 를 지우면 그 worktree 를 연 tmux 세션의 프로세스 트리와(Linux) cwd 가 그 안인 같은 사용자 프로세스를 끝낸다. 실행 중인 `minmo` 자신과 그 조상 셸은 제외한다.

### 서버 모드 / 로컬 모드

`minmo mode local` · `minmo mode server` 로 **명시적으로** 바꾼다(기본은 서버 모드). 모드는 `~/.config/minmo/config.json` 에 남는다.

| | 서버 모드 | 로컬 모드 |
|---|---|---|
| 연결 | 이 PC 에서 연 SSH 역터널 필요 | 필요 없음(어느 기기에서 SSH 해도 됨) |
| 로그인 | `minmo login <코드>` 필요 | 필요 없음 |
| 설정·보일 저장소 | 서버 값(데스크탑과 공유) | **로컬 값 → 서버 사본 → 기본값**. `minmo config`·`minmo repos` 는 로컬 값을 바꾸고 서버로 올리지 않는다 |
| 메모 | 사용 | 사용 안 함(서버 모드에서만) |
| GitHub | gh → `GITHUB_TOKEN` → 서버 토큰 | gh → `GITHUB_TOKEN`(둘 중 하나 필수) |
| worktree 열기·삭제·tmux·프로세스 정리 | 같음 | 같음 |

- **서버 사본:** 서버 모드에서 받은 값(전역 설정·보일 저장소·조직 설정·연 저장소의 설정)을 `state.json` 에 남겨 로컬 모드의 기본값으로 쓴다. `minmo mode local` 을 실행할 때 서버에 닿고 로그인돼 있으면 사본을 새로 받는다 — 관련 조직(보일 저장소·worktree 의 소유자, GitHub 에서 보이는 조직)의 설정과, worktree 가 있거나 보일 저장소로 고른 저장소의 설정까지. 서버 모드에서 `minmo config set` 으로 바꾼 값도 사본에 바로 반영된다. 사본에 없는 저장소의 서버 **프로젝트** 설정은 로컬 모드에서 쓰이지 않는다(조직·전역 사본·기본값).
- **설정 우선순위(로컬 모드):** 기본값 ← 서버 사본 ← 로컬 전역 ← 로컬 조직 ← 로컬 프로젝트. 로컬 값은 서버 규칙과 같은 검증을 거친다. `minmo config get --effective owner/repo` 가 값마다 출처를 보여 준다.
- worktree 기록은 두 모드가 함께 쓴다 — 어느 모드에서 만든 worktree 든 다른 모드에서 열고 지울 수 있다.

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
