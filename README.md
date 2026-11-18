# minmo

GitHub 조직 > 저장소 > 이슈를 트리로 보여 주고, 이슈를 열면 설정(전역 → 조직 → 프로젝트 상속)에 따라
브랜치·git worktree 를 준비하고 생성 후 스크립트를 실행한 뒤, 그 안에서 터미널·커밋·PR·메모를 한 화면에서
처리하는 개인 개발 워크플로우 도구다. 메모·설정은 Go 서버(SQLite)에 저장해 이후 모바일과 공유한다.

현재 범위는 **Phase 1**(로컬 Go 서버 + Tauri 데스크탑)이다. 상세 요구사항은
[`docs/specs/20261109-minmo-issue-worktree-workspace-spec.md`](docs/specs/20261109-minmo-issue-worktree-workspace-spec.md) 참고.

## 릴리즈 받기

[GitHub Releases](https://github.com/kangmomin/minmo-cli/releases) 에 버전마다 다음 파일을 올린다.

| 파일 | 내용 |
|------|------|
| `minmo_<버전>_x64-setup.exe` · `minmo_<버전>_x64_en-US.msi` | 데스크탑 앱(Windows 설치 파일, 둘 중 하나). **서버가 함께 설치되어 앱과 같이 실행된다.** 코드 서명이 없어 처음 실행 때 SmartScreen 경고가 뜰 수 있다(추가 정보 → 실행) |
| `*.sig` · `latest.json` | 자동 업데이트용 서명·버전 정보(앱이 읽는다) |
| `kangmomin-minmo-cli-<버전>.tgz` | 원격 CLI 패키지 파일 — 보통은 아래처럼 npm(GitHub Packages)으로 설치한다 |
| `SHA256SUMS.txt` | 체크섬 |

(v0.2.0 까지는 서버 실행 파일을 따로 올렸다. v0.3.0 부터 서버는 데스크탑 설치 파일에 들어 있다.)

### 업데이트

- **데스크탑**: v0.4.0 부터 자동 업데이트된다. 앱을 켜면 새 버전을 확인해 상단에 안내하고, [설치하고 다시 시작]을 누르면 서버를 정상 종료한 뒤 서명을 확인한 설치 파일로 업데이트하고 다시 실행한다. 앱이 켜져 있는 동안 12시간마다 다시 확인하고, 서버 설정의 **앱 → 업데이트 확인** 으로 직접 확인할 수도 있다. 서명에 담긴 버전과 안내된 버전이 다르면 설치하지 않는다(다운그레이드 방지). v0.3.0 이하는 v0.4.0 을 한 번 직접 설치해야 한다.
  - msi 로 설치했다면 업데이트 때 관리자 승인 창이 뜬다. 거절하면 업데이트되지 않고 앱도 다시 열리지 않으니 앱을 다시 켜면 된다.
- **원격 CLI**: 명령이 끝날 때 새 버전이 있으면 알린다(하루 한 번 확인, `MINMO_NO_UPDATE_CHECK=1` 로 끔). `minmo update` 로 업데이트하고, `minmo update --check` 로 버전만 본다.

### 처음 실행

1. 설치 파일을 실행하고 minmo 를 켠다. 서버(`minmo-server`)가 앱과 함께 `127.0.0.1:8787` 에서 시작된다.
2. **GitHub로 로그인** 을 누르면 화면에 8자리 코드가 보이고 브라우저에 `github.com/login/device` 가 열린다.
3. 브라우저에서 그 코드를 입력하고 승인하면 앱이 자동으로 로그인된다. OAuth App 을 따로 등록할 필요가 없다. 조직 저장소가 보이지 않으면 그 조직의 **Third-party access** 에서 minmo 앱을 승인한다.

서버 설정은 로그인 화면과 상단 바의 서버 아이콘에서 연다.

| 항목 | 내용 |
|------|------|
| 포트 | 기본 `8787`. 바꾸면 서버가 새 포트로 다시 시작되고 앱이 다시 연결한다(열린 터미널은 닫힌다). 원격 CLI 의 `RemoteForward` 도 함께 바꾼다 |
| 창을 닫을 때 | 매번 묻기(기본) · 트레이로 최소화 · 종료. 트레이로 최소화하면 창을 닫아도 서버가 계속 실행되어 원격 CLI 를 쓸 수 있다. 트레이 아이콘 클릭이나 앱을 다시 실행하면 창이 나타나고, 트레이 메뉴의 [종료]로 앱과 서버를 함께 끝낸다. 매번 묻기에서 3초 안에 X 를 다시 누르면 바로 종료한다(화면이 응답하지 않을 때) |

- 서버의 토큰 암호화 키는 처음 실행할 때 만들어 OS 키체인에 둔다(입력할 필요 없음).
- 데이터: 설정·DB 는 `%APPDATA%\com.minmo.desktop`(`server.json`, `minmo.db`), 서버 로그는 `%LOCALAPPDATA%\com.minmo.desktop\logs\server.log`(직전 실행은 `server.prev.log`). 서버 설정의 **로그 폴더 열기** 로 연다.
- 서버를 시작하지 못하면(예: 포트를 다른 프로그램이 사용) 원인과 [다시 시작]·[서버 설정]이 나온다. 앱이 비정상 종료해도 서버는 함께 끝난다.

## 모노레포 구조

| 경로 | 내용 |
|------|------|
| `server/` | Go API 서버(`net/http` + SQLite). 단일 Go 모듈 `github.com/kangmomin/minmo-cli/server` — 루트에 `go.mod` 가 없으므로 Go 명령은 `cd server` 후 실행 |
| `server/cmd/minmo-server` | API 서버 진입점 |
| `server/cmd/githubmock` | E2E 전용 GitHub OAuth(기기 코드)/API mock 서버 |
| `desktop/` | Tauri 2 + React/TS 데스크탑 앱 |
| `packages/api-client/` | 공유 TS 타입·API 클라이언트·템플릿 치환(`@minmo/api-client`) |
| `packages/core/` | 데스크탑·원격 CLI 공용 도메인 로직 — worktree 서비스·GitHub 클라이언트·보일 저장소 판정(`@minmo/core`) |
| `packages/cli/` | 원격 CLI — SSH 역터널로 데스크탑 서버에 로그인해 메모·설정·보일 저장소를 다룬다(`minmo-cli`, bin `minmo`) |
| `contracts/fixtures/` | 서버·클라이언트가 함께 읽는 API 계약 fixture |
| `mobile/` | Phase 3 RN 앱 자리 |
| `docs/specs/` | 기능 Spec |

## 서버

보통은 데스크탑 앱이 서버를 함께 실행하고 아래 env 를 채워 준다(`desktop/src-tauri/src/server.rs`). 이 섹션은 서버를 직접 실행할 때(개발·E2E)의 안내다.

### 요구 사항

- Go 1.26 이상 (cgo 불필요 — 순수 Go SQLite 드라이버 `modernc.org/sqlite`)

### 서버 env

| 변수 | 기본 | 비고 |
|------|------|------|
| `MINMO_LISTEN` | `127.0.0.1:8787` | 비loopback 바인딩은 `MINMO_ALLOW_NON_LOOPBACK=1` 없으면 기동 거부 |
| `MINMO_ALLOW_NON_LOOPBACK` | (없음) | `1` 이면 `0.0.0.0` 등 외부 바인딩 허용 |
| `MINMO_PUBLIC_URL` | `http://127.0.0.1:8787` | 서버가 자신을 가리키는 주소(시작 로그에 표시) |
| `MINMO_DB_PATH` | `./minmo.db` | SQLite 파일 경로(WAL). 시작 시 마이그레이션 자동 적용 |
| `MINMO_TOKEN_KEY` | **(필수)** | base64 32바이트, GitHub access token AES-256-GCM 암호화 키. 없으면 기동 실패 |
| `MINMO_GITHUB_CLIENT_ID` | 서버에 들어 있는 minmo OAuth App 의 Client ID(`config.DefaultGitHubClientID`) | 기기 코드 로그인에 쓴다(Secret 없음). 비어 있으면 `POST /auth/github/device/start` → 503 `github_oauth_not_configured` |
| `MINMO_GITHUB_OAUTH_BASE` / `MINMO_GITHUB_API_BASE` | `https://github.com` / `https://api.github.com` | E2E 는 githubmock 주소로 치환 |
| `MINMO_CORS_ORIGINS` | `http://localhost:1420,tauri://localhost,http://tauri.localhost,https://tauri.localhost` | 쉼표 구분 |
| `MINMO_STOP_ON_STDIN_CLOSE` | (없음) | `1` 이면 stdin 이 닫힐 때 정상 종료(데스크탑이 사이드카를 끌 때) |

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

### GitHub 로그인(기기 코드 방식)

로그인은 GitHub 의 [Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) 를 쓴다. Client Secret 이 필요 없어서, minmo 용 OAuth App 하나의 Client ID 만 서버에 넣어 배포한다 — 사용자가 OAuth App 을 등록할 필요가 없다.

1. `POST /auth/github/device/start` → `{deviceId, userCode, verificationUri, expiresIn, interval}`. 서버가 GitHub 에서 기기 코드를 받아 두고(`device_code` 는 서버 메모리에만), 사용자에게 보일 코드와 승인 주소를 돌려준다.
2. 사용자가 `verificationUri`(`https://github.com/login/device`)에서 `userCode` 를 입력해 승인한다.
3. `POST /auth/github/device/poll {deviceId}` 를 `interval` 초마다 호출한다 → `{status:"pending", interval}` 또는 `{status:"ok", session}`. 거부는 400 `access_denied`, 만료는 400 `device_code_expired`. 확인 간격은 서버가 지킨다(너무 이른 요청은 GitHub 에 묻지 않는다).

요청 scope 는 `repo read:org read:user` 다. 조직 저장소가 보이지 않으면 GitHub 의 해당 조직 **Third-party access** 에서 minmo OAuth App 을 승인한다.

다른 OAuth App 을 쓰려면(직접 빌드 등) OAuth App 설정에서 **Enable Device Flow** 를 켜고 그 Client ID 를 `MINMO_GITHUB_CLIENT_ID` 로 준다.

### 로컬 실행

```bash
cd server
export MINMO_TOKEN_KEY="$(openssl rand -base64 32)"   # 재시작해도 같은 값을 쓰도록 보관
go run ./cmd/minmo-server
curl http://127.0.0.1:8787/healthz   # {"status":"ok"}
```

```powershell
cd server
$env:MINMO_TOKEN_KEY = "<생성한 키>"
go run ./cmd/minmo-server
```

### 테스트

```bash
cd server
go build ./... && go vet ./... && go test ./...
```

`server/internal/httpapi/contract_test.go` 는 `contracts/fixtures/` 를 읽는 공용 계약 테스트다.

### E2E (githubmock)

실제 GitHub 대신 `cmd/githubmock`(기본 `127.0.0.1:8790`, env `GITHUBMOCK_LISTEN`)을 띄워 기기 코드 로그인을 재현한다. 발급한 기기 코드는 기본으로 바로 승인된다(`gho_mock_token` → 사용자 `octocat`).

다음에 발급할 기기 코드의 결과는 `POST /mock/device/next {"result": …}` 로 정한다(GitHub 에는 없는 테스트용 경로).

| result | 결과 |
|--------|------|
| `mock-code-ok`(기본) | 바로 승인 — `gho_mock_token` → 사용자 `octocat`(id 583231) |
| `mock-code-user2` | 바로 승인 — `gho_mock_token2` → 사용자 `hubot`(id 480938, avatar 없음) |
| `mock-code-pending` | `authorization_pending` 2번 뒤 승인 |
| `mock-code-slow` | `slow_down`(interval 10) 1번 뒤 승인 |
| `mock-code-denied` / `mock-code-expired` | `access_denied` / `expired_token` |
| `mock-code-5xx` | 토큰 확인 HTTP 500 → 502 `github_unavailable` |

```bash
# 1) mock → 2) 서버 순서로 기동
(cd server && go run ./cmd/githubmock) &
(cd server && MINMO_TOKEN_KEY="$(openssl rand -base64 32)" MINMO_GITHUB_CLIENT_ID=e2e \
  MINMO_GITHUB_OAUTH_BASE=http://127.0.0.1:8790 MINMO_GITHUB_API_BASE=http://127.0.0.1:8790 \
  MINMO_DB_PATH=/tmp/minmo-e2e.db go run ./cmd/minmo-server) &

# 3) 로그인: device/start → device/poll({"status":"ok","session":…})
ID=$(curl -s -X POST http://127.0.0.1:8787/auth/github/device/start | sed -E 's/.*"deviceId":"([^"]+)".*/\1/')
curl -s -X POST http://127.0.0.1:8787/auth/github/device/poll -H 'Content-Type: application/json' -d "{\"deviceId\":\"$ID\"}"
```

`go run` 은 자식 프로세스를 따로 띄우므로 종료 시 해당 프로세스(`minmo-server`, `githubmock`)까지 정리한다.

## 데스크탑

```bash
npm ci
npm run typecheck && npm test
npm run e2e        # Playwright(Tauri mock)
```

Tauri 네이티브 빌드는 Rust(cargo)와 Go 가 필요하다. 서버는 사이드카로 설치 파일에 들어간다.

- `npm run build:server --workspace desktop` 이 `desktop/src-tauri/binaries/minmo-server-<host triple>[.exe]` 를 빌드한다. `tauri dev`·`tauri build` 는 먼저 이것을 실행한다. `cargo test`·`clippy` 를 직접 돌릴 때도 먼저 한 번 실행해 둔다(없으면 Tauri 빌드 스크립트가 실패).
- 앱은 시작할 때 서버를 띄우고 그 포트로 붙는다. `VITE_MINMO_SERVER` 를 주면(개발·Playwright) 그 주소를 대신 쓴다.
- debug 빌드 전용 env
  - `MINMO_DESKTOP_PROFILE=<폴더>`: 설정·DB·로그를 그 폴더에 두고 키체인 서비스를 `com.minmo.desktop.dev` 로 분리한다.
  - `MINMO_EXTERNAL_SERVER=1`: 사이드카를 띄우지 않는다(따로 띄운 서버 + `VITE_MINMO_SERVER`).
  - `MINMO_GITHUB_OAUTH_BASE` / `MINMO_GITHUB_API_BASE` / `MINMO_GITHUB_CLIENT_ID`: 사이드카에 넘긴다(githubmock 로그인 E2E). 그 밖의 `MINMO_*` env 는 사이드카에 넘기지 않는다.
- 설치된 앱이 켜져 있는 PC 에서 debug 앱을 함께 띄우려면 identifier 를 바꿔 빌드한다(같으면 single-instance 로 설치된 앱에 넘어간다): `TAURI_CONFIG='{"identifier":"com.minmo.desktop.e2e"}' cargo build`. 키체인 서비스 이름도 identifier 를 따라 분리된다.
- 자동 업데이트: debug 빌드는 `MINMO_UPDATER_ENDPOINT`(latest.json URL, http 가능)·`MINMO_UPDATER_PUBKEY`(시험 키 공개키)가 있을 때만 확인한다.

### 릴리즈 만들기

릴리즈는 GitHub Actions(`.github/workflows/release.yml`)가 만든다.

1. 버전을 올리는 PR 을 머지한다 — 루트·`desktop`·`packages/cli` 의 `package.json`, `tauri.conf.json`, `Cargo.toml`(+ lock). 릴리즈 노트는 `docs/releases/v<버전>.md`(없으면 자동 생성).
2. `main` 에 `v<버전>` 태그를 push 한다. workflow 가 버전 일치·CLI 테스트를 확인하고, Windows 에서 설치 파일(사이드카 서버 포함)을 업데이트 서명(`.sig`)과 함께 빌드한 뒤, CLI 를 GitHub Packages 에 배포하고, 마지막에 Release(설치 파일·`.sig`·`latest.json`·tgz·체크섬)를 공개한다.
3. 수동 실행(Actions → release → Run workflow)이나 릴리즈 파일을 바꾼 PR 은 dry-run 이다 — 일회용 키로 서명해 빌드·매니페스트까지만 하고 결과는 artifact 로 남긴다.

업데이트 서명 키
- 공개키는 `tauri.conf.json` 의 `plugins.updater.pubkey`, 개인키는 environment **release** 의 secret `TAURI_SIGNING_PRIVATE_KEY` 에 있다(이 environment 는 `v*` 태그에서만 쓸 수 있다. 원본: 관리자 PC 의 `~/.tauri/minmo-updater.key`, 비밀번호 없음).
- **개인키를 잃으면 이미 설치된 앱에 업데이트를 보낼 수 없다**(새 키로 바꾸면 사용자가 새 버전을 한 번 직접 설치해야 한다). 개인키는 따로 안전하게 백업한다.
- 로컬 `tauri build` 는 서명 없이 된다(`createUpdaterArtifacts` 는 workflow 에서만 켠다). 로컬에서 서명까지 하려면 `TAURI_SIGNING_PRIVATE_KEY` 를 주고 `--config '{"bundle":{"createUpdaterArtifacts":true}}'`.

트리 상단의 **표시할 저장소** 버튼으로 보일 저장소를 고른다(서버에 저장되어 원격 CLI 와 공유). 로컬 worktree 가 있는 저장소는 빼도 "숨김" 표시와 함께 보인다.

저장소를 펼치면 이슈 목록은 ★기타 → 작업 중인 이슈(지금 보는 호스트에 worktree 가 있는 이슈) → 나머지 순이고, 각각 번호가 큰 것부터다. 이슈가 10개보다 많은 저장소에는 목록 위에 **이슈 검색** 칸이 생긴다 — 번호(`42`, `#42`)와 제목으로 찾고(여러 단어는 모두 맞아야 한다), Esc 로 지운다. 먼저 불러온 목록(열린 이슈와 worktree 가 있는 닫힌 이슈, 최대 500개) 안에서 찾고(`desktop/src/features/tree/issueSearch.ts`), 입력이 멈추면 GitHub 에도 물어 목록에 없는 열린 이슈를 아래에 붙인다(최대 30개) — GitHub 쪽은 제목의 단어 전체가 맞아야 하고, 번호는 하나만 쳤을 때 그 번호의 이슈를 찾는다. 찾은 줄을 누르면 검색어를 지워도 목록에 남는다. 본문·라벨은 보지 않고, "에이전트가 있는 이슈만" 을 켜면 GitHub 에 묻지 않는다.

상단의 테마 버튼으로 색을 바꾼다: **Ghostty**(기본 — Ghostty 터미널의 기본 색을 터미널 16색·앱 화면·파일 편집기에 쓴다) → 블랙 → 라이트. 색 값은 `desktop/src/lib/ghostty.ts` 와 `index.css` 의 `.ghostty` 에 있다.

터미널의 복사·붙여넣기는 Windows Terminal 과 같다: 글자를 선택하고 **Ctrl+C** 는 복사(선택이 없으면 셸로 보내 실행 중인 명령을 중단), **Ctrl+V** 는 붙여넣기. Ctrl+Shift+C / Ctrl+Shift+V 도 된다. **Ctrl+Backspace** 는 앞 단어 지우기, **Shift+Enter** 는 전송하지 않는 줄바꿈(Claude Code·Codex 의 입력창)이다. 패널 단축키는 Ctrl+D(오른쪽 분할)·Ctrl+Shift+D(아래 분할)·Ctrl+W(닫기)다(`desktop/src/features/terminal/keys.ts`). 이슈를 고르면 작업 폴더(worktree)만 준비하고 터미널은 만들지 않는다 — **Ctrl+T**(또는 [터미널 열기] 버튼)로 열고, 이미 열려 있으면 Ctrl+T 는 오른쪽에 새 패널을 만든다. 터미널 탭을 보는 중에 터미널이 열린 이슈를 트리에서 누르면(클릭·Enter·터치) 그 이슈에서 마지막으로 쓴 터미널 패널로 포커스가 가서 바로 입력할 수 있다. 터미널이 없거나 다른 탭(변경·파일·메모)을 보는 중이면 포커스는 누른 행에 남는다.

터미널의 링크(일반 URL·OSC 8 링크)는 **Ctrl+클릭** 으로 브라우저에서 연다(http·https 만, `desktop/src/features/terminal/links.ts`). ssh 로 접속한 원격의 프로그램(tmux 복사 모드, Claude Code 의 드래그 복사 등)이 OSC 52 로 복사하면 이 PC 의 클립보드에 들어간다 — 쓰기만 받고, 클립보드를 읽는 요청에는 답하지 않는다(`osc52.ts`). 프로그램이 마우스를 쓰면 드래그가 그 프로그램으로 가므로, 터미널에서 선택하려면 **Shift+드래그** 한 뒤 Ctrl+C 를 누른다.

터미널과 파일 편집기의 글자 크기는 **Ctrl +**(키우기) · **Ctrl -**(줄이기) · **Ctrl 0**(기본 13px)으로 바꾼다(9~28px, 이 PC 에 저장). 서버 설정 대화상자의 "글자 크기" 에서도 바꿀 수 있다(`desktop/src/lib/fontSize.ts`).

사이드바 폭은 사이드바 오른쪽 경계를 끌어(또는 경계에 포커스하고 **←/→** · **Home** · **End**) 240~480px 로 바꾼다. 경계를 더블클릭하면 기본 폭(288px)으로 돌아가며, 폭은 이 PC 에 저장한다(`desktop/src/features/tree/SidebarFrame.tsx`).

## 에이전트 현황

터미널에서 도는 코딩 에이전트(Claude Code · Codex · Gemini CLI)와 그 밖의 프로그램이 지금 무엇을 하는지 보여 준다. 상태는 터미널 출력으로 **추정**한다(`desktop/src/features/agents/`).

| 상태 | 뜻 |
|------|----|
| 작업 중 | 에이전트가 일하는 중 |
| 입력 대기 | 벨이 울렸거나 에이전트가 사용자 확인을 요청함 |
| 끝남 | 작업을 마쳤고 그 터미널을 아직 보지 않음(보면 "대기 중"이 된다) |
| 대기 중 | 에이전트가 떠 있고 다음 지시를 기다림 |

- **어디에 보이나:** 트리의 이슈 행(점), 터미널 패널 오른쪽 위(이름·상태), 상단의 **에이전트 현황** 버튼(작업 중·확인 필요 수), 그리고 OS 알림(끝났거나 입력을 기다릴 때 — 그 터미널을 보고 있지 않을 때만, 서버 설정에서 끌 수 있다). 알림을 누르면 창이 앞으로 오고 그 터미널 패널로 간다(다른 PC 의 알림은 그 PC 의 창을 연다 — Windows 는 알림이 화면에 떠 있을 때의 클릭만 전달한다).
- **전체 현황:** 상단 버튼으로 연다. 모든 이슈의 에이전트를 한 목록으로 보고 **필터**(상태·에이전트·검색), **정렬**(급한 순·최근 활동·이름), **묶기**(저장소·상태·에이전트·호스트)를 고른다. 줄을 누르면 그 이슈의 터미널로 간다. 사이드바의 로봇 버튼은 트리에 에이전트가 있는 이슈만 남긴다.
- **감지 방법:** 에이전트가 정하는 창 제목(Claude Code 는 `✳` 대기 · `◐`/`◑` 작업 중, Gemini CLI 는 `◇` 대기 · `✦` 작업 중 · `✋` 확인 필요), 이 PC 에서는 터미널에서 도는 프로세스 이름, 그리고 출력이 이어지는지(제목에 상태를 넣지 않는 Codex 와 기타 프로그램 — 4초 동안 출력이 없으면 끝난 것으로 본다). 원격 호스트는 "원격 터미널에 tmux 사용"을 켰을 때 tmux 가 프로그램 이름과 제목을 전달한다(끄면 제목만 보므로 Claude Code · Gemini CLI 만 감지한다).
- **하위 에이전트(Claude Code):** Claude Code 가 띄운 하위 에이전트의 종류·설명·실행 여부를 세션 기록(`<설정 폴더>/projects/<작업 폴더>/<세션>/subagents/agent-*.meta.json`, 설정 폴더는 `CLAUDE_CONFIG_DIR` 또는 `~/.claude`)에서 5초마다 읽는다. 패널 머리줄에 실행 중인 수가, 전체 현황에는 에이전트 줄 아래에 목록이 보이고 "하위 에이전트 수" 정렬과 "실행 중인 것만" 필터를 쓸 수 있다. 기록 형식은 공개된 규격이 아니라 Claude Code 버전에 따라 읽지 못할 수 있다(그때는 상태만 보인다). 사용자의 Claude Code 설정은 건드리지 않는다.
- **에이전트 실행:** 이슈 머리줄의 **[에이전트 실행]** 또는 트리의 이슈 메뉴 **에이전트 실행…** 에서 에이전트(Claude Code · Codex · Gemini CLI · 직접 입력)와 지시문을 정하면, 그 이슈의 새 터미널 패널에 명령을 입력해 실행한다(쓰던 터미널에는 끼워 넣지 않는다). 지시문에는 이슈 번호·제목이 미리 채워지고, 명령 틀의 `{prompt}` 자리에 셸에 맞게 작은따옴표로 감싸져 한 줄로 들어간다(이 PC 의 Windows PowerShell 에서는 큰따옴표가 작은따옴표로 바뀐다). 고친 명령 틀과 마지막으로 고른 에이전트는 이 PC 에 저장된다. 실행한 뒤의 진행은 위의 현황·알림으로 보며, minmo 가 작업을 대신 판단하거나 이어 가지는 않는다(`desktop/src/features/agents/launch.ts`).
- 기타 프로그램(빌드·개발 서버 등)은 전체 현황과 패널에만 보이고, 트리의 점과 알림에는 넣지 않는다.

## AI 사용량(하단 바)

창 아래의 한 줄에 지금 보는 호스트(사이드바의 작업 호스트)의 AI 별 사용량을 보인다. 예: `office-dev  Claude 1.2M 오늘 · Codex 5h 34% 주 12%`.

| 도구 | 보이는 값 | 읽는 곳 |
|------|-----------|---------|
| Claude Code | 오늘 쓴 토큰 수 | `<설정 폴더>/projects/*/*.jsonl`(하위 에이전트 포함)의 `message.usage` |
| Codex | 한도 사용률(%) — 한도 기록이 없으면 오늘 쓴 토큰 수 | `<CODEX_HOME>/sessions/<년>/<월>/<일>/*.jsonl` 의 `token_count` |
| Gemini CLI | 오늘 쓴 토큰 수 | `~/.gemini/tmp/*/chats/*.json` 의 `messages[].tokens` |

- **토큰 수:** 그 화면의 오늘 자정부터, 그 컴퓨터의 모든 프로젝트에서 쓴 양이다(minmo 밖에서 쓴 것 포함). 새로 읽은 입력 + 출력 + 캐시에 쓴 입력을 더하고, 캐시에서 다시 읽은 입력은 넣지 않는다(요청마다 대화 전체가 다시 세어진다) — 마우스를 올리면 따로 보인다. 같은 응답이 여러 줄에 기록된 것은 한 번만 센다.
- **한도 사용률:** Codex 를 **마지막으로 쓴 시점**의 값이다(실시간이 아니다). 초기화 시각이 지난 한도는 0% 로 보이고, 80% 이상은 "높음", 100% 는 "한도 도달"이 붙는다. Claude Code · Gemini CLI 의 한도 사용률은 기록에 없어 보이지 않는다(계정 API 는 부르지 않는다).
- **원격 호스트:** ssh 로 그 호스트의 기록을 읽는다. 원격에 `python3` 이 있어야 한다(없으면 그 사실만 알린다).
- 1분마다 다시 읽는다. 기록은 읽기만 하고, 도구의 설정은 건드리지 않는다. 쓰지 않는 도구는 보이지 않는다. 보일 것이 없어도 바는 같은 높이로 남는다(생겼다 없어지면 터미널이 크기를 다시 맞춘다).
- 설정 폴더는 `CLAUDE_CONFIG_DIR` · `CODEX_HOME` 이 있으면 그것, 없으면 홈의 `.claude` · `.codex` 다. 이 변수를 셸의 시작 파일에서만 정했으면 앱(이 PC)이나 ssh 명령(원격)에는 보이지 않아 홈의 폴더를 읽는다 — 그때는 값이 실제보다 적다.
- 기록 형식은 공개된 규격이 아니라 도구 버전에 따라 읽지 못할 수 있다(그때는 그 도구가 보이지 않는다).
- 서버 설정의 "하단 바에 AI 별 사용량 표시"로 끈다(이 PC 에 저장).
- 계산은 이 PC 는 Rust(`desktop/src-tauri/src/commands/usage.rs`), 원격은 python3(`desktop/src/features/usage/remoteUsage.ts`)로 하며, 같은 fixture(`desktop/src-tauri/tests/fixtures/usage`)로 맞춘다.

## 새 프로젝트 · 저장소 열기

사이드바의 **+**(저장소 추가) 메뉴에서 트리에 저장소를 더한다. 목록은 이 PC 의 앱에 저장한다(`desktop/src/store/repos.ts`).

| 메뉴 | 동작 |
|------|------|
| 새 프로젝트 | 이름·위치를 정하면 폴더를 만들어 `git init` 하고 빈 첫 커밋을 만든다. GitHub 저장소는 만들지 않는다 |
| 폴더 열기 | 이미 있는 저장소 폴더를 연다. origin 이 `github.com` 저장소면 그 저장소로(폴더는 기준 저장소), 아니면 로컬 저장소로 연다. 이 PC 는 폴더 선택 창을 쓸 수 있다 |
| GitHub 저장소 추가 | 내 계정·내 조직 소유가 아니어서 목록에 없는 저장소를 `owner/name` 으로 더한다 |

- **로컬 저장소**(GitHub 가 아닌 폴더)는 트리의 "로컬 저장소" 아래에 보이고, 이슈 대신 앱 안에서 만드는 **작업**(번호 1, 2, 3…)을 쓴다. 작업마다 브랜치·worktree·터미널·파일·커밋·메모를 이슈와 똑같이 쓴다. 내부적으로는 소유자 `_local` 아래의 저장소로 다뤄 설정·메모가 같은 방식으로 저장된다.
- origin 이 없으면 fetch 를 건너뛰고 새 브랜치를 저장소의 현재 브랜치에서 만든다. PR 버튼은 없고, origin 이 없으면 push 버튼도 없다.
- **GitHub 에 올리기**(origin 이 없는 로컬 저장소의 메뉴): GitHub 저장소를 만들어 모든 브랜치를 push 하고 트리 항목을 GitHub 저장소로 바꾼다. 작업은 같은 번호의 이슈가 되고 메모·프로젝트 설정도 옮긴다. 실패하면 같은 메뉴에서 이어서 진행한다.
- 원격 호스트를 보고 있으면 새 프로젝트·폴더 열기는 그 호스트에서 이뤄진다(경로 직접 입력).

### 저장소 별칭

긴 저장소 이름 대신 짧은 별칭을 쓴다. **프로젝트 설정 → 별칭** 에 입력하면 바로 적용된다(비우면 원래 이름).

- 트리·이슈 머리줄·에이전트 현황·알림·대화상자 제목에 원래 이름 대신 별칭만 보인다. 마우스를 올리면 원래 이름(`owner/name`, 로컬 저장소는 폴더 경로)이 보인다.
- **표시할 저장소** 대화상자에서 원래 이름과 별칭 어느 쪽으로도 찾는다.
- worktree 경로 설정의 `{alias}` 가 별칭으로 바뀐다. 별칭이 없으면 저장소 이름(로컬 저장소는 폴더명)이다. 예: `~/work/{alias}/{branch}`.
  - 별칭을 바꾸면 경로도 바뀐다 — 이미 있는 worktree 는 그대로 쓰고 "경로 변경됨" 표시가 붙는다. 새 이슈부터 새 경로에 만든다.
  - 메인 clone 경로에는 쓸 수 없다(별칭을 바꿀 때마다 저장소를 다시 clone 하게 되므로).
  - 이름이 같은 저장소끼리는 폴더가 겹칠 수 있다(이 PC 가 아는 저장소와 겹치면 입력할 때 알린다). 겹치면 worktree 를 만들지 않고 멈추니, 별칭을 달아 구분한다.
- 별칭은 이 PC 의 앱에만 저장한다(`desktop/src/store/repos.ts` 의 `nicknames`). 원격 접속한 기기(휴대폰·브라우저)와는 함께 쓰고, 서버·원격 CLI·다른 PC 와는 공유하지 않는다 — 다른 PC 에서는 `{alias}` 가 저장소 이름이 된다.

## 새 worktree 에 무시된 파일 가져오기

worktree 를 새로 만들면 `.gitignore` 로 빠진 파일(`.env` 등)을 원본 폴더에서 복사해, 바로 실행·테스트할 수 있게 한다(`packages/core/src/worktree.ts` 의 `copyIgnored`).

- **원본:** 메인 저장소 폴더가 체크아웃된 저장소면(로컬 저장소·기준 저장소) 그 폴더 → 아니면 같은 저장소의 ★기타 worktree → 그것도 없으면 가장 최근에 커밋한 다른 worktree. 앞 후보에 가져올 것이 없으면 다음 후보를 본다. 원본이 없으면(첫 worktree) 건너뛴다.
- **대상:** 원본에서 `git ls-files --others --ignored --exclude-standard --directory` 가 내는 파일·폴더. 경로 어디에든 **제외 이름**이 있으면 뺀다(통째로 무시된 폴더 안쪽도 같고, 중첩 저장소의 `.git` 은 항상 뺀다). 새 worktree 의 `.gitignore` 로도 무시되는 것만 가져온다(`git check-ignore`) — 원본 브랜치에서만 무시되던 파일이 새 브랜치에서 커밋 대상으로 보이지 않게. 기본 제외는 `node_modules`·`target`·`dist`·`build`·`out`·`.next`·`.nuxt`·`.venv`·`venv`·`__pycache__`·`.gradle`·`.turbo`·`.cache`·`coverage`. 여기 없는 큰 폴더는 그대로 복사되니 설정에 추가한다.
- **설정:** 전역·조직·저장소 설정의 "무시된 파일 가져오기"(`ignoredCopyExclude` — 제외 이름을 한 줄에 하나, `off` 면 가져오지 않음).
- **순서:** [로컬 파일] 에 보관해 둔 파일 → 무시된 파일 → 생성 후 스크립트. 이미 있는 파일은 덮어쓰지 않으므로 보관해 둔 파일이 우선한다. 심볼릭 링크는 따라가지 않는다.
- 일부 폴더만 체크아웃하는 저장소는 그 폴더 안과 최상위 파일만 가져온다. 일부 파일을 복사하지 못해도 나머지는 복사하고, 이슈는 열리며 준비 기록에 사유가 남는다. worktree 삭제는 진행 중인 복사가 끝난 뒤에 이뤄진다.

## 원격 접속 (다른 PC · 휴대폰)

다른 PC 나 휴대폰의 브라우저에서 이 PC 의 minmo 를 쓴다. 데스크톱 앱이 작은 HTTP + WebSocket 서버를 띄우고(기본은 꺼짐, 기본 포트 8790), 앱에 들어 있는 것과 같은 화면을 내준다(`desktop/src-tauri/src/remote.rs`).

1. 상단의 **원격 접속** 버튼 → **원격 접속 켜기**. 접속 주소가 나온다.
2. **[기기 등록]** → 6자리 코드(2분, 1회용)와 QR 코드가 뜬다.
3. 다른 기기의 브라우저로 그 주소를 열고 코드를 입력한다. 이후에는 그 브라우저에 저장된 기기 토큰으로 바로 들어온다.

- **연결:** 중계 서버 없이 직접 연결한다. Tailscale 주소(`tailscale ip -4` 가 알려 준 것만)와 `127.0.0.1` 에 열고, 설정에서 켜면 사설 LAN 주소에도 연다. 공인 주소에는 열지 않는다. 요청의 Host 가 IP·점 없는 이름·`*.ts.net` 이 아니면 거절한다(DNS rebinding 방지). LAN 연결은 암호화되지 않는다(믿을 수 있는 네트워크에서만).
- **무엇을 쓰나:** 이슈 트리, 에이전트 현황, 터미널, 변경·파일·메모. 터미널은 이 PC 의 창과 **함께 본다** — 패널마다 터미널 하나이고, 나중에 붙은 화면은 지금까지의 출력(최근 256KB)을 받아 그린다. 크기는 터미널을 누른 화면에 맞춘다.
- **함께 쓰는 상태:** 저장소 목록, 작업 폴더 위치, 터미널 패널 구성, 에이전트 실행 명령은 이 PC 의 설정 폴더(`shared/*.json`)에 두고 붙어 있는 화면들이 맞춘다. 저장할 때 판 번호를 확인해, 그 사이 다른 화면이 저장했으면 다시 읽어 자기가 바꾼 항목만 얹는다(`desktop/src/lib/sharedState.ts`). 테마·글자 크기·펼침 상태·지금 보는 이슈는 기기마다 따로다.
- **권한:** 등록한 기기는 이 PC 를 터미널로 조작할 수 있다 — 그 사용자 권한으로 할 수 있는 일은 모두 할 수 있다는 뜻이다. 기기 토큰은 해시만 저장하고, 기기 목록에서 [끊기] 로 무효로 한다(새 요청은 바로 거절, 열린 연결은 몇 초 안에 닫힘). 로그인, 서버·원격 접속 설정, 키체인, 업데이트, 폴더 선택 창, SSH 호스트 등록은 원격에서 부를 수 없다. minmo 서버(`/api` — 설정·메모·보일 저장소·내 정보만)와 GitHub API(`/gh`) 요청은 이 PC 가 대신 보내므로 원격 화면에는 세션·GitHub 토큰을 내려보내지 않는다.
- **휴대폰:** 좁은 화면에서는 목록과 작업 화면을 하나씩 보이고 터미널 패널도 하나씩 본다. 터미널 위에 Esc·Tab·방향키·Ctrl+C·줄바꿈 키 줄이 뜬다. 변경·파일 탭은 위아래로 쌓인다. 브라우저 알림과 홈 화면에 추가(`desktop/public/manifest.webmanifest`)는 HTTPS 가 필요하다 — 아래 Tailscale 도우미의 [HTTPS 로 열기].
- **Tailscale 도우미:** 같은 대화상자의 **Tailscale** 영역이 상태에 따라 다음 할 일 하나를 보여 준다 — [Tailscale 설치] → [Tailscale 로그인] → 연결됨 → [HTTPS 로 열기]/[HTTPS 끄기] (`desktop/src-tauri/src/tailscale.rs`, `features/remote/TailscaleSection.tsx`). 실행하는 명령은 코드에 정해 둔 것뿐이고 화면이 프로그램이나 인자를 넘기지 못하며, 붙은 기기는 이 명령들을 부를 수 없다.
  - 설치: Windows 는 `winget install --id Tailscale.Tailscale -e --source winget --accept-source-agreements --accept-package-agreements` 를 버튼을 눌렀을 때만 실행한다(명령을 먼저 보여 준다). macOS(Homebrew 가 .pkg 를 설치)와 Linux 는 관리자 암호가 필요해 명령만 안내한다. 설치 파일을 앱이 직접 내려받지는 않는다.
  - 로그인: `tailscale up` 이 알려 준 로그인 주소를 브라우저로 연다. 상태(`tailscale status --json`)를 몇 초마다 다시 읽어 스스로 다음 단계로 넘어간다.
  - HTTPS: `tailscale serve --bg --https=443 http://127.0.0.1:<원격 접속 포트>` — tailnet 안에서만 열린다(`funnel` 은 쓰지 않는다). 443 의 `/` 하나가 원격 접속 포트(또는 minmo 가 마지막으로 건 포트 — 설정 폴더의 `tailscale.json`)를 가리킬 때만 minmo 의 설정으로 보고, 사용자가 따로 건 serve 설정(다른 경로·대상, `funnel` 로 인터넷에 연 것)이 있으면 켜지도 끄지도 않는다. 원격 접속을 끄면 함께 끄고, 포트를 바꾸면 새 포트로 다시 건다 — 그때 Tailscale 이 꺼져 있어 맞추지 못했으면 [HTTPS 로 열기] 가 다시 나온다. `--bg` 설정이라 앱을 끝내도 남는다(앱이 꺼져 있으면 그 주소는 응답하지 않는다). tailnet 에서 HTTPS 가 꺼져 있으면 켜는 주소를 안내한다.
- **여러 PC:** 같은 대화상자의 **다른 PC** 에 그 PC 의 주소와 등록 코드를 넣으면 이 PC 가 그 PC 의 "기기"가 된다(토큰은 키체인, 목록은 설정 폴더의 `peers.json`). 등록한 PC 의 에이전트는 이 PC 의 현황·알림에 합쳐지고(`features/remote/peerAgents.ts` — 각 PC 는 자기 현황을 올려 두고, 등록한 쪽이 WebSocket 으로 받아 간다), 호스트 고르는 곳이나 현황의 줄에서 그 PC 의 화면을 **새 창**으로 연다. 새 창은 그 PC 가 내준 화면이라 이 앱의 네이티브 명령을 부를 수 없다(권한은 main 창에만 있다). 틀(iframe)로 끼워 넣지 않는 이유: 브라우저 엔진이 앱 화면에서 사설 네트워크 주소의 틀을 여는 것을 막는다.
- **동기화:** 등록한 PC 와 메모·설정(브랜치 이름 틀·기타 브랜치 이름·sparse 경로)·저장소 목록(GitHub 저장소, 더하기만)을 맞춘다(`features/remote/peerSync.ts`). 등록한 쪽이 두 PC 의 내용을 읽어 — 각 서버의 시각 차이를 보정해 — 나중에 고친 쪽을 가리고 각자에게 필요한 것만 보낸다. 각 PC 서버의 `GET·PUT /me/sync`(내보내기 · 더 새로운 것만 넣기)를 쓰고, 양쪽에서 고친 메모는 밀린 쪽 내용을 "충돌 사본"으로 붙여 양쪽에 둔다. **실행되는 값(생성 후 스크립트·작업 폴더 경로·에이전트 실행 명령)은 맞추지 않는다** — 서버가 이 경로로는 내보내지도 받지도 않는다. 연결될 때 한 번, 그 뒤 1분마다, 또는 [지금 동기화].
- **구조:** 화면의 네이티브 호출은 모두 `TauriApi`(`desktop/src/lib/tauri.ts`)를 거친다. 원격 화면은 그 구현만 `tauri.remote.ts`(WebSocket)로 바꾼다. 터미널과 공유 상태는 Rust 가 바로 처리하고, 나머지 호출은 이 PC 의 화면이 대신 실행한다(`features/remote/useRemoteHost.ts`) — 그래서 앱이 떠 있어야 한다(트레이에 숨겨도 된다).

## 원격 호스트 (SSH)

데스크탑 앱에서 원격 호스트의 worktree·터미널·파일을 직접 다룬다. 이 PC 의 `ssh` 로 접속하므로, 원격에 minmo CLI·역터널·로그인 코드가 필요 없다.

1. 사이드바 위의 **원격 호스트 관리** 버튼에서 호스트를 고른다.
   - `~/.ssh/config` 의 Host 를 [연결 확인] 하고 [추가] 하거나,
   - **호스트 직접 등록** 으로 이름·호스트 주소·사용자·포트·키 파일을 넣어 앱에 저장한다(`ssh-hosts.json`, 비밀번호는 저장하지 않는다).
   - 처음 접속하는 호스트는 [호스트 키 등록하고 연결] 로 `known_hosts` 에 등록한다(키가 바뀐 호스트는 등록하지 않는다).
2. 그 옆 **작업 호스트** 목록에서 호스트를 고르면, 트리의 ●·이슈 열기·터미널·변경·파일·로컬 파일이 그 호스트 기준으로 동작한다. worktree 기록은 호스트마다 따로다. 저장소마다 호스트를 따로 정할 수도 있다 — 아래 [저장소별 연결 호스트](#저장소별-연결-호스트).
3. 열어 둔 이슈와 터미널은 다른 호스트로 바꿔 보는 동안에도 유지된다(이슈 제목 옆의 호스트 배지로 구분).

| 준비물 | 설명 |
|---|---|
| 프롬프트 없는 접속 | 키 파일 또는 ssh-agent 로 묻지 않고 접속되어야 한다. 비밀번호 입력 방식은 지원하지 않는다 |
| 원격 OS | Linux·macOS(POSIX 셸). 원격 Windows 는 지원하지 않는다 |
| git | 원격에 설치되어 있어야 한다 |
| tmux(선택) | 터미널은 기본으로 일반 로그인 셸이다(앱을 끄거나 연결이 끊기면 함께 끝난다). **원격 호스트** 대화상자에서 "원격 터미널에 tmux 사용"을 켜면, tmux 가 있는 호스트의 터미널이 전용 tmux(`tmux -L minmo`) 세션이 되어 앱을 끄거나 연결이 끊겨도 유지된다. 분할로 만든 추가 패널은 닫으면 사라진다. 설정은 새로 여는 터미널부터 적용된다 |

### 저장소별 연결 호스트

**프로젝트 설정**의 "연결 호스트"에서 저장소마다 이슈를 열 호스트(이 PC 또는 원격 호스트)를 정한다. 정한 저장소는 사이드바의 작업 호스트와 관계없이 그 호스트에서 worktree·터미널·변경·파일을 쓴다 — 예: 작업 호스트는 "이 PC" 로 두고, 한 저장소만 원격 호스트에서 연다.

- 기본은 "작업 호스트 따름"(지금처럼 사이드바에서 고른 호스트).
- 트리에서 그 저장소 이름 옆에 호스트 배지가 붙는다. 원격 호스트에 아직 연결하지 않았으면 연결을 확인한 뒤에 이슈 목록이 보인다(트리에 보일 때 한 번 자동으로 연결하고, 실패하면 [다시 시도]). 연결하기 전에 이 PC 에서 여는 일은 없다.
- 열어 둔 이슈는 연 호스트에 그대로 남는다. 앱을 다시 켜거나 호스트 정보를 고치면 그 이슈의 호스트에 다시 연결하고, 연결한 뒤 이슈 화면을 보인다(그동안 터미널은 그대로).
- 이 PC 의 앱에 저장하고 원격 접속한 기기와 함께 쓴다(원격 CLI·다른 PC 와는 맞추지 않는다). 원격 호스트 목록에서 그 호스트를 빼도 연결 호스트는 남는다(목록은 기기마다 따로다) — 바꾸려면 프로젝트 설정에서 고른다.
- 연결 호스트에 닿지 않아도 프로젝트 설정의 서버 설정(브랜치 템플릿 등)은 고칠 수 있다. 원본 위치와 경로 미리보기만 연결한 뒤에 보인다.
- 다른 PC 의 화면에서 이 PC 의 이슈를 열 때(링크)도 같다 — 터미널 패널이 정해져 있으면 그 패널의 호스트, 아니면 연결 호스트에 연결한 뒤 연다.
- 로컬 저장소(GitHub 가 아닌 폴더)는 폴더가 있는 호스트에 이미 묶여 있어 정할 수 없다.

### 기준 저장소(기존 폴더 가져오기)

저장소 노드의 **기준 저장소 폴더** 버튼(또는 우클릭 메뉴), 또는 **프로젝트 설정**의 "원본 위치"에서 그 호스트에 이미 clone 해 둔 저장소 폴더를 지정하면, 새로 clone 하지 않고 그 저장소에서 이슈별 worktree 를 만든다(`git worktree add`).

- 그 폴더의 체크아웃은 건드리지 않는다. worktree 는 설정의 worktree 경로 템플릿에 만든다.
- 지정은 호스트마다 따로이며 "이 PC" 에서도 쓸 수 있다. 비워 두면 설정의 메인 clone 경로에 clone 한다.
- 로컬 파일 보관 폴더는 그 저장소의 `.git/minmo-local` 이다(옆 폴더 `_local` 은 다른 저장소와 겹칠 수 있어 쓰지 않는다).
- 그 폴더에서 이미 체크아웃한 브랜치와 같은 이슈 브랜치는 git 이 거부한다.
- 지정한 값은 이 PC 의 창과 원격 접속한 기기(휴대폰·브라우저)가 함께 쓴다.

### worktree 경로의 시작

설정의 worktree 경로는 다음 중 하나로 시작한다. 원본은 메인 clone 폴더다(기준 저장소·로컬 저장소는 그 폴더).

| 시작 | 뜻 | 예 (원본 `/src/app`) |
|---|---|---|
| `.` · `..` | 원본 기준 상대 경로 | `../app-wt/{branch}` → `/src/app-wt/<branch>` |
| `~` | 홈 | `~/work/{repo}/{branch}` |
| `/` (Windows 는 `C:\`·`\\server\share` 도) | 절대 경로. Windows 에서 `/` 로 시작하면 원본이 있는 드라이브의 루트 | Windows 원본 `D:\src\app` 에서 `/wt/{branch}` → `D:\wt\<branch>` |

- 원본 폴더 안(예: `./wt/{branch}`)이나 원본을 품는 상위 폴더에는 만들지 않는다 — "메인 clone 과 겹침"으로 멈춘다. 원본 옆(`../`)을 쓴다.
- `{alias}` 는 [저장소 별칭](#저장소-별칭)(없으면 저장소 이름)이다. 메인 clone 경로에는 쓸 수 없다.
- 원본 기준 경로에는 `{repo}` 를 넣는다(예: `../{repo}-wt/{branch}`). 기준 저장소들이 같은 상위 폴더에 있으면 `../{branch}` 는 저장소끼리 겹친다.
- `.` 으로 시작하는 폴더 이름(예: `.worktrees/...`)은 원본 기준이 아니다 — `./` 또는 `../` 로 시작한다.
- 원본 기준으로 적으면 원본 위치가 기기마다 달라도 같은 설정을 함께 쓸 수 있다.
- 메인 clone 경로는 `~` 또는 절대 경로만 쓴다.

### 호스트별 기본 폴더

**원격 호스트** 대화상자의 "기본 폴더"에서 이 PC 와 원격 호스트마다 worktree 와 메인 clone 을 둘 폴더를 정한다(예: 한 호스트는 `/workspace`).

- 경로 설정(worktree 경로·메인 clone 경로)이 `~/minmo-workspaces` 로 시작할 때 그 부분을 대신한다. 예: `/workspace/{owner}/{repo}/{branch}`.
- 경로 설정의 앞부분을 다른 값으로 바꿨으면(예: `~/work/...`) 적용하지 않는다 — 위치를 직접 정한 것으로 본다.
- 값은 이 PC 에 저장하고 서버에 올리지 않는다(경로 설정은 모든 기기가 함께 쓴다). 이 PC 의 창과 원격 접속한 기기는 같은 값을 쓴다.
- 이미 만든 worktree 는 옮기지 않는다. 기본 폴더를 바꾼 뒤 처음 여는 저장소는 새 위치에 메인 clone 을 다시 받는다.
- 기준 저장소 폴더를 지정한 저장소는 메인 clone 대신 그 폴더를 쓰고, 기본 폴더는 worktree 위치에만 적용된다.

### 원격 git 인증

앱이 원격에서 실행하는 git(clone·fetch·push 등)에는 이 PC 의 GitHub 토큰(`gh` 로그인 토큰, 없으면 minmo 로그인 토큰)을 그때그때 넘긴다. 원격에 자격 증명을 따로 설정하지 않아도 된다.

- 토큰은 ssh 연결의 입력으로만 보내 git 프로세스의 환경 변수로 둔다 — 원격의 디스크·git 설정·명령줄(`ps`)에 남지 않는다.
- GitHub 와 통신하는 명령(clone·fetch·push 등)과 worktree 생성에만 넘기고, status·diff·commit 등에는 넘기지 않는다. 넘긴 명령이 실행하는 저장소 hook 은 그 환경 변수를 볼 수 있으므로, 믿지 않는 호스트·저장소에서는 쓰지 않는다.
- `https://github.com` 주소에만 적용된다. SSH 주소(`git@github.com:`)를 쓰는 저장소는 원격의 SSH 키를 쓴다.
- 터미널에서 직접 치는 `git push` 에는 적용되지 않는다(원격 자체의 자격 증명 필요).

### 파일 탭

작업 탭의 **파일** 에서 worktree 의 파일 트리를 보고 텍스트 파일을 편집한다(이 PC·원격 공통). 새 파일·새 폴더·이름 바꾸기·삭제, 문법 강조, `Ctrl+S` 저장.

- 2MB 이하의 UTF-8 텍스트만 연다. 심볼릭 링크는 열지 않고, 링크를 지나는 경로는 쓰지 않는다.
- 연 뒤에 파일이 다른 곳(터미널·에이전트)에서 바뀌었으면 덮어쓰기 전에 묻는다.
- 저장 안 한 내용은 탭·이슈를 오가도 유지되지만 앱을 끄면 사라진다.

### 그 밖에

- 경로·스크립트 설정은 이 PC 와 같은 값을 쓴다: 경로 템플릿의 `~` 는 원격의 홈으로 풀리고(호스트마다 다른 위치는 [호스트별 기본 폴더](#호스트별-기본-폴더)로 정한다), 생성 후 스크립트는 **Linux/macOS(sh)** 쪽이 실행된다.
- GitHub 조회·PR 만들기·메모는 계속 이 PC 에서 한다.
- Windows 의 OpenSSH 는 연결 재사용(ControlMaster)을 지원하지 않아 동작마다 새로 접속한다 — 이 PC 보다 조금 느리다(변경 내역은 15초마다 확인).
- Windows 에서는 기본 제공 OpenSSH(`C:\Windows\System32\OpenSSH\ssh.exe`)를 먼저 쓴다(키는 Windows ssh-agent).
- debug 빌드 전용 env `MINMO_SSH_CONFIG=<파일>`: `~/.ssh/config` 대신 그 설정 파일을 쓴다(E2E 격리).

원격 터미널에서 메모·설정·보일 저장소를 다루려면 아래 **원격 CLI** 를 함께 쓴다.

## 원격 CLI (SSH)

원격 서버에 `minmo` CLI 를 설치하면, SSH 로 접속한 그 서버의 터미널에서 데스크탑과 공유하는 데이터(메모·설정·보일 저장소)를 보고 바꿀 수 있다.
데이터는 이 PC 의 minmo 서버에 있고, 원격 CLI 는 **SSH 역터널**로 그 서버를 쓴다(서버는 계속 `127.0.0.1` 에서만 듣는다).
worktree·터미널은 CLI 가 아니라 데스크탑의 [원격 호스트](#원격-호스트-ssh) 기능으로 다룬다.

### 요구 사항(원격)

- Linux·macOS·Windows, Node.js 22.12 이상
- 원격 CLI 를 쓰는 동안 이 PC 의 데스크탑 앱(서버)이 켜져 있어야 한다
- 원격이 Windows 면 [Windows 에서 쓰기](#windows-에서-쓰기) 를 본다

### 설치

CLI 는 GitHub Packages 에 `@kangmomin/minmo-cli` 로 배포된다. GitHub Packages 의 npm 레지스트리는 공개 패키지도 **토큰이 있어야 설치**되므로, 원격(예: Ubuntu)에서 한 번 `~/.npmrc` 를 설정한다.

```bash
# 1) read:packages 권한 토큰 — gh 를 쓰면 권한을 더한 뒤 그 토큰을 쓴다(없으면 GitHub 의 classic PAT 에 read:packages)
gh auth refresh -h github.com -s read:packages
cat >> ~/.npmrc <<EOF
@kangmomin:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=$(gh auth token)
EOF

# 2) 설치(이후 업데이트는 minmo update)
npm i -g @kangmomin/minmo-cli
mkdir -p ~/.minmo
```

- Node.js 22.12 이상이 필요하다. Ubuntu 기본 apt 의 `nodejs` 는 이보다 낮을 수 있으니 nvm 이나 NodeSource 로 22 를 설치한다.
- 저장소에서 직접 만들려면 `npm ci && npm run pack:cli` → `dist/kangmomin-minmo-cli-<버전>.tgz` 를 원격에 복사해 `npm i -g ./kangmomin-minmo-cli-<버전>.tgz`.

### SSH 설정(이 PC 의 `~/.ssh/config`)

```
Host my-server
  HostName <원격 주소>
  User <사용자>
  RemoteForward /home/<사용자>/.minmo/server.sock 127.0.0.1:8787
```

- 데스크탑 서버 설정에서 포트를 바꿨다면 `8787` 대신 그 포트를 쓴다(데스크탑 "원격 CLI 접속" 화면의 예시는 설정된 포트로 보여 준다). 원격 CLI 를 쓰는 동안 데스크탑 앱(서버)이 켜져 있어야 하므로, 창을 닫을 때 **트레이로 최소화** 를 고르면 편하다.
- TCP 포트 대신 **Unix 소켓**으로 역터널한다 — 원격의 다른 사용자가 포트로 접근하거나, 포트 충돌로 토큰이 엉뚱한 곳으로 가는 일을 막는다. CLI 는 `MINMO_SERVER` 를 명시하지 않으면 소켓만 쓰고(127.0.0.1:8787 로 넘어가지 않음), 소켓 소유자가 자신이 아니면 연결하지 않는다.
- 원격 **sshd_config** 에 `StreamLocalBindUnlink yes` 가 있어야 재접속 때 이전 소켓을 바꿔 쓴다(관리자 설정, 클라이언트 쪽 같은 이름의 옵션은 RemoteForward 에 효과가 없다). 없으면 재접속 전에 원격에서 `rm ~/.minmo/server.sock` — `minmo doctor` 가 남은 소켓을 알려 준다. 같은 이유로 `ExitOnForwardFailure` 는 넣지 않는다(남은 소켓 때문에 접속 자체가 막힌다).
- 원격 sshd 가 `AllowStreamLocalForwarding` 을 허용해야 한다(기본 허용). 원격에 `~/.minmo` 폴더가 먼저 있어야 한다.
- 소켓 대신 다른 주소를 쓰려면 `MINMO_SERVER=http://…`, 소켓 경로는 `MINMO_SOCKET`.

### 로그인

1. 데스크탑 상단 바 **원격 CLI 접속** → **코드 발급**(10분, 1회용)
2. 원격에서 `minmo login ABCD-EFGH` — 이 기기 이름(hostname)으로 세션이 만들어지고, 데스크탑의 같은 다이얼로그에서 확인·끊기 할 수 있다
3. `minmo doctor` 로 터널·로그인 점검

자격 증명은 `~/.config/minmo/credentials.json`(권한 0600)에 둔다. 이전 버전이 남긴 `config.json`·`state.json` 은 더 읽지 않는다(지워도 된다).
CLI 는 시작할 때 서버 계정이 로그인한 계정과 같은지 확인한다(다른 서버로 연결된 터널에 토큰을 보내지 않게).

### 사용

| 명령 | 내용 |
|------|------|
| `minmo login <코드>` · `minmo logout` | 로그인 · 이 기기의 세션을 끊고 로그인 정보 지우기 |
| `minmo doctor` | 역터널 소켓·서버 응답·로그인 점검 |
| `minmo note owner/repo#42` | 메모를 `$EDITOR` 로 편집(다른 기기와 충돌하면 내 내용을 파일로 보존) |
| `minmo repos [add\|rm\|all] …` | 보일 저장소(데스크탑과 공유). `owner/*` 는 조직 전체 |
| `minmo config [get\|set] … [--org o\|--project o/r]` | 설정(데스크탑과 공유). 여러 줄 값은 `@파일`, `-` 는 상속. `get --effective owner/repo` 는 값마다 출처를 보여 준다 |
| `minmo sessions [revoke <id>]` | 로그인된 기기 |
| `minmo update [--check]` | 새 버전으로 업데이트 |

- `minmo` 만 입력하면 도움말을 보여 준다(명령을 주지 않았으므로 종료 코드 1). 없는 명령은 `unknown command` 로 알린다.
- 이전 버전의 TUI 와 `ls`·`new`·`open`·`rm`·`mode`(로컬 모드)·`terminal`·`base-dir`·`base-repo` 는 없앴다. worktree·터미널·이슈 등록은 데스크탑(원격 호스트 포함)에서 한다.
- 설정의 경로는 기기 간에 공유되므로 `~` 로 시작하게 둔다.

### Windows 에서 쓰기

| | Linux·macOS | Windows |
|---|---|---|
| 서버 연결 | 역터널 Unix 소켓 `~/.minmo/server.sock` | **`MINMO_SERVER` 필수**(Node 가 Unix 소켓 파일에 붙지 못한다). 같은 PC: `MINMO_SERVER=http://127.0.0.1:8787` · 원격: `RemoteForward 127.0.0.1:18787 127.0.0.1:8787` + `ExitOnForwardFailure yes` 후 `MINMO_SERVER=http://127.0.0.1:18787` |
| 설정 폴더 | `~/.config/minmo` | `%APPDATA%\minmo` |
| 기본 편집기(`minmo note`) | `vi` | 메모장을 열고 저장한 뒤 Enter(`EDITOR` 로 바꿈, 예: `code --wait`) |

- TCP 역터널 포트는 그 PC 의 다른 사용자도 열 수 있다. 다른 사용자가 먼저 포트를 열어 두면 CLI 가 세션 토큰을 그쪽에 보낸다 — CLI 의 계정 확인은 서버를 인증하지 못한다. `ExitOnForwardFailure yes` 로 포트를 열지 못하면 접속을 끊게 하고, 여러 사람이 쓰는 PC 라면 WSL 의 Linux 버전(Unix 소켓)을 쓴다.

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
