# Spec: minmo — GitHub 이슈 단위 worktree 작업 공간 (Phase 1: 서버 + 데스크탑)

- 상태: 구현 준비 완료
- 유형·도메인: 생성 · fullstack
- 작성: 2026-11-09, ready-for-impl 인터뷰 (질문 10회 — 사용자 지시로 상한 8회 초과, Spec 수정 1회 반영)

### 작업 계약
- 대상: 저장소 `C:\workspace\minmo-cli` (브랜치 `master`, 초기 커밋만 존재). 신규 모노레포
  `server/`(Go), `desktop/`(Tauri + React/TS), `mobile/`(React Native, Phase 3 자리만), `packages/`(공유 TS 타입·API 클라이언트)
- 기준: 이 인터뷰의 결정 로그 D-01~D-30. 참조 구현 없음(빈 저장소). UI 참고 모델은 Orca 데스크탑(트리 + 작업 탭 구조)
- 범위: 로드맵 전체 중 **Phase 1**만 구현 — GitHub 로그인, 조직/프로젝트/이슈 트리, 이슈→브랜치+worktree, "기타" 고정 이슈,
  터미널, git 변경·커밋·push·PR, 이슈별 메모, 전역→조직→프로젝트 3단계 설정(브랜치 템플릿·worktree 경로·메인 clone 경로·생성 후 스크립트)
  / 제외: 모바일 앱, 데스크탑 원격 제어, 클라우드 배포, 반복 명령 단축어, worktree 자동 정리, GitHub webhook,
  AI 에이전트 실행·커밋 메시지 자동 생성, GitHub 이슈 생성·편집
- 완료: Go 단위 테스트 + 서버 API E2E(GitHub 호출 모킹) 통과, 데스크탑 F-01~F-09 수동 확인 기록.
  서버는 로컬 실행만. 작업 단위 커밋 → push → draft PR (start-workflow 승인 후)
- 승인: 이 Spec 내용 확정까지. 구현·커밋·push·PR은 승인되지 않음
- 미결: 없음

## 기능 목표
GitHub 조직 > 저장소 > 이슈를 트리로 보여 주고, 이슈를 열면 설정(전역→조직→프로젝트 상속)에 따라 브랜치·worktree가 준비되고
생성 후 스크립트가 실행되어, 그 안에서 터미널·커밋·PR·메모를 한 화면에서 처리할 수 있어야 한다. 메모·설정은 서버에 저장해 이후 모바일과 공유한다.

## 로드맵 (개요)
| Phase | 내용 | 비고 |
|-------|------|------|
| 1 (이번) | Go 서버(로컬) + Tauri 데스크탑: 로그인·트리·worktree·터미널·git·PR·메모·3단계 설정 | 이 Spec |
| 2 | 클라우드 배포, 서버 측 GitHub REST 동기화(모바일용), 멀티 디바이스 세션 | 서버 캐시 전략 재결정 필요 |
| 3 | RN 모바일: 조회 + 메타데이터 편집(메모·설정) + 데스크탑 원격 제어(터미널·git 중계) | 데스크탑 ↔ 서버 ↔ 모바일 실시간 채널 |
| 후속 | 반복 명령 단축어 실행, AI 에이전트 세션, worktree 자동 정리 | A-11 단축어는 Phase 1 선택에 포함되지 않아 후속으로 배치 |

## 현재 상황 (As-Is)
| 파일 | 역할 | 수정 필요 |
|------|------|----------|
| (없음 — 초기 커밋만 존재) | | 전부 신규 |

### 참조 구현
- 없음. UI 구조는 Orca 데스크탑(좌측 트리 + 중앙 작업 탭)을 참고하되 코드는 독자 구현

## 변경 사항 (To-Be)
```
minmo-cli/
├─ server/                 Go 1.22+, net/http(or chi), SQLite(modernc.org/sqlite), golang-migrate
│  ├─ cmd/minmo-server/    진입점, 기본 http://127.0.0.1:8787  (A-03)
│  ├─ internal/auth/       GitHub OAuth(PKCE) 교환, 세션 발급
│  ├─ internal/settings/   전역/조직/프로젝트 3단계 설정 + effective 병합
│  ├─ internal/note/       이슈별 메모
│  └─ migrations/
├─ desktop/                Tauri 2 + React + TypeScript + Vite
│  ├─ src-tauri/           Rust: PTY(portable-pty), git/gh 프로세스 실행, 생성 후 스크립트 실행기(로그 스트리밍·취소), keychain 저장
│  └─ src/                 트리·탭 UI(xterm.js, diff 뷰, 마크다운 메모, 설정 다이얼로그)
├─ packages/api-client/    서버 API 타입·클라이언트(TS, desktop·mobile 공유)
├─ mobile/                 README만(Phase 3 자리)
└─ README.md
```

## Feature Matrix
| ID | 사용자 흐름 | 프론트(데스크탑) 책임 | 백엔드(서버) 책임 | 완료 조건 |
|----|------------|---------------------|------------------|----------|
| F-01 | GitHub 로그인 | 브라우저 열기, 딥링크 수신, 세션·GitHub 토큰 keychain 저장 | OAuth 교환, 사용자 upsert, 세션 발급, 전역 설정 기본 레코드 생성 | AC-01, AC-02 |
| F-02 | 조직/저장소/이슈 트리 | gh(우선)/REST(폴백)로 조회, 트리 렌더, 새로고침 | 없음(Phase 1은 서버 캐시 없음) | AC-03, AC-04 |
| F-03 | 이슈 열기 → worktree | effective 설정 조회, clone/fetch/branch/worktree add, 상단 바 표시 | effective 설정 제공 | AC-05~AC-07 |
| F-04 | 터미널 | worktree cwd로 PTY 생성, xterm 렌더 | 없음 | AC-08 |
| F-05 | 변경·커밋·push·PR | status/diff, 스테이징, 커밋, push, PR 생성 | 없음 | AC-09~AC-11 |
| F-06 | 메모 | 마크다운 편집, 디바운스 저장, 오프라인 표시 | 메모 CRUD, 사용자 격리 | AC-12 |
| F-07 | 전역/조직/프로젝트 설정 | 트리 노드 컨텍스트 메뉴 → 설정 폼(상속 값 placeholder, 브랜치·경로 미리보기) | 3단계 저장·검증, effective 병합 응답 | AC-13, AC-15 |
| F-08 | 닫힌 이슈·worktree 정리 | 닫힘 배지, 삭제 전 경고, "기타" 삭제 불가 | 없음 | AC-14 |
| F-09 | 생성 후 스크립트 | worktree 생성 직후 스크립트 실행, 진행 로그 패널, 취소·재실행 | 스크립트 본문 저장 | AC-16 |

## 화면/컴포넌트 (데스크탑)
- 위치: 단일 창, 라우트 `/login` → `/` (메인)
- 구성: 좌측 `Sidebar`(조직 트리, 새로고침), 중앙 `IssueHeader`(repo·브랜치·커밋·PR 버튼),
  `WorkTabs`(터미널 / 변경 / 메모), 상단 우측 ⚙ `SettingsButton`(전역), 하단 `OfflineBanner`(서버 미연결 시)
- `SettingsDialog(scope: global|org|project)`: 필드마다 "상속: {상위 값}" placeholder, 비워 두면 상속.
  하단에 현재 이슈 기준 미리보기(브랜치명, 해석된 worktree 경로). 진입: ⚙(전역), org 노드 우클릭 "조직 설정", repo 노드 우클릭 "프로젝트 설정"
- `WorktreeSetupLog`: 이슈 열기 진행 로그(clone → fetch → worktree add → 스크립트) + [취소] [다시 실행]

## 레이아웃 (확정)
```
┌──────────────────┬───────────────────────────────────────┐
│ [▼ 개인계정 ]     │ owner/repo  ⎇ issue/42-login  [커밋][PR]│
│ ▼ my-org         ├──────┬──────┬──────────────────────────┤
│   ▼ repo-a       │ 터미널 │ 변경 │ 메모                      │
│     ★ 기타       ├──────┴──────┴──────────────────────────┤
│     #42 로그인 ●  │ $ go test ./...                       │
│     #45 버그  (닫힘)│ ok  server/auth  0.12s                │
│   ▶ repo-b       │                                       │
│                  │                                       │
│ [⟳ 새로고침]      │                                       │
└──────────────────┴───────────────────────────────────────┘
● = 로컬 worktree 있음, ★ = "기타" 고정 이슈(항상 첫 행), (닫힘) = GitHub 상태 closed
```

## 데이터 연동 (데스크탑 → 외부)
| 소스 | 호출 | 사용 필드 | 호출 시점 | 캐시 |
|------|------|----------|----------|------|
| GitHub (gh 또는 REST) | `/user`, `/user/orgs`, `/orgs/{org}/repos`, `/user/repos?affiliation=owner`, `/repos/{o}/{r}/issues?state=all` | login, avatar, name, default_branch, number, title, state, html_url | 로그인 직후, 새로고침, 저장소 노드 펼칠 때 | 메모리(세션 내) |
| 서버 | `/me`, `/settings`, `/orgs/.../settings`, `/projects/.../settings`, `/projects/.../settings/effective`, `/projects/.../issues/{key}/notes` | 아래 API | 로그인, 이슈 열기, 설정 폼, 메모 편집 | 메모리 + 메모는 로컬 읽기 캐시 |
| 로컬 git | clone/fetch/worktree/status/diff/commit/push | — | 이슈 열기, 변경 탭 진입, 버튼 | 없음 |

## UI 상태
| 상태 | 표현 |
|------|------|
| loading | 트리 스켈레톤, 탭 내 스피너, worktree 준비 중 진행 로그(clone/fetch/worktree/스크립트 단계) |
| empty | 조직에 저장소 없음 / 이슈 없음 → "★ 기타"만 표시 |
| success | 트리·탭 렌더 |
| error | GitHub 오류: 트리 상단 인라인 메시지 + 재시도 / 서버 오류: 하단 OfflineBanner, 메모·설정 편집 비활성(읽기 캐시만) / git·스크립트 오류: 로그 패널에 stderr 전문 표시 |

## API (서버, Phase 1)
| Method | Path | 설명 | 인증 |
|--------|------|------|------|
| POST | `/auth/github/start` | authorizeUrl·state 발급 (PKCE) | 없음 |
| GET | `/auth/github/callback` | code 교환, 사용자 upsert(+전역 설정 기본 레코드), 세션 발급 후 `minmo://auth?session=…`로 302 | 없음(state 검증) |
| GET | `/me` | 로그인 사용자 | 세션 |
| GET | `/me/github-token` | 데스크탑 REST 폴백·clone용 GitHub 토큰 | 세션 |
| DELETE | `/auth/session` | 로그아웃 | 세션 |
| GET/PUT | `/settings` | 전역 설정(모든 필드 non-null) | 세션 |
| GET/PUT | `/orgs/{owner}/settings` | 조직(개인 계정 포함) 설정, 필드 nullable | 세션 |
| GET/PUT | `/projects/{owner}/{repo}/settings` | 프로젝트 설정, 필드 nullable | 세션 |
| GET | `/projects/{owner}/{repo}/settings/effective` | 3단계 병합 결과 + 필드별 출처(scope) | 세션 |
| GET | `/projects/{owner}/{repo}/issues/{key}/notes` | 메모 (key = 이슈 번호 또는 `etc`) | 세션 |
| PUT | `/projects/{owner}/{repo}/issues/{key}/notes` | 메모 저장(전체 치환) | 세션 |
| GET | `/me/visible-repos` | (v2.7, E15) 보일 저장소 `{repos: string[]\|null, updatedAt}` — null = 전체 표시 | 세션 |
| PUT | `/me/visible-repos` | (v2.7, E16) 전체 교체 `{repos, baseUpdatedAt?}` — 소문자 `owner/repo`·`owner/*`, ≤1000, 409 conflict | 세션 |
| POST | `/me/cli-codes` | (v2.7, E17) 원격 CLI 1회용 로그인 코드 `{code, expiresAt}`(10분, 사용자당 1개) | 세션 |
| POST | `/auth/cli/exchange` | (v2.7, E18) `{code, label}` → `{session}`(kind=cli). 실패 400 `invalid_cli_code` | 없음 |
| GET | `/me/sessions` | (v2.7, E19) 세션 목록 `{sessions:[{id, kind, label, createdAt, lastUsedAt, current}]}` | 세션 |
| DELETE | `/me/sessions/{id}` | (v2.7, E20) 본인 세션 폐기(204), 없으면 404 | 세션 |

### Request/Response — settings 공통 필드
| 필드 | 타입 | 전역 필수 | 검증 |
|------|------|----------|------|
| branchTemplate | string? | ✔ | `{number}` 포함, 토큰 `{number}` `{slug}` `{title}`, git ref 금지 문자(공백, `..`, `~^:?*[\`) 없음, ≤100자 |
| etcBranchName | string? | ✔ | ref 규칙, 토큰 금지 |
| worktreePath | string? | ✔ | `{branch}` 또는 `{key}` 포함(유일성), 토큰 `~` `{owner}` `{repo}` `{branch}` `{key}` `{number}` `{slug}`, ≤512자 |
| mainClonePath | string? | ✔ | 토큰 `~` `{owner}` `{repo}`, `{branch}`·`{key}` 금지, ≤512자 |
| postCreateScript | string? | ✔(빈 문자열 허용) | ≤64KB |
| sparsePaths (v2.6) | string? | 전역 PUT 에서 생략·null 이면 저장값 유지(없으면 `""`) | 줄바꿈 구분 저장소 기준 상대 폴더(cone sparse-checkout), 빈 줄 무시, 절대 경로·`..`·`\`·`:`·glob(`*?[]`)·`!`·`#`·`-` 시작 금지, ≤100줄·≤4KB. `""` = 전체 체크아웃. 오류 `invalid_sparse_paths` |
| postCreateScriptPosix (v2.7) | string? | 전역 PUT 에서 생략·null 이면 저장값 유지(없으면 `""`) | ≤64KB. Linux/macOS(sh) 생성 후 스크립트 — macOS 데스크탑·원격 CLI 가 쓴다. `postCreateScript` 는 Windows(PowerShell) 용 |
| updatedAt | string | — | 응답 전용, nullable |

- 전역 초기 레코드 기본값: `issue/{number}-{slug}`, `etc`, `~/minmo-workspaces/{owner}/{repo}/{branch}`,
  `~/minmo-workspaces/{owner}/{repo}/_main`, `""`
- 조직·프로젝트 scope에서 null = 상속
- effective 응답: `{ values: {branchTemplate, etcBranchName, worktreePath, mainClonePath, postCreateScript, sparsePaths, postCreateScriptPosix}, sources: { <field>: "global"|"org"|"project" } }`
- 경로 토큰 치환은 데스크탑에서 수행. `~`는 홈 디렉터리, `{branch}`의 `/`는 `--`로 치환(A-06). `{key}` = 이슈 번호 또는 `etc`

### Request — PUT notes
| 필드 | 타입 | 필수 | 검증 |
|------|------|------|------|
| body | string | ✔ | ≤ 1MB |
| baseUpdatedAt | string(RFC3339) | ✖ | 있으면 서버 값과 비교해 충돌 감지 |

### Response — notes
| 필드 | 타입 | nullable | 설명 |
|------|------|----------|------|
| body | string | ✖ | 메모 본문(없으면 `""`) |
| updatedAt | string | ✔ | 저장 이력 없으면 null |

### Response — /me
| 필드 | 타입 | nullable | 설명 |
|------|------|----------|------|
| id, githubLogin, avatarUrl | string | avatarUrl ✔ | |

### 원격 CLI (v2.7, 후속 추가)
- 원격 호스트에 `minmo-cli`(tgz) 를 설치해 SSH 로 쓴다. 서버는 loopback 에 두고, 이 PC 의 `ssh` 가 원격 `~/.minmo/server.sock` 으로 역터널한다(`RemoteForward`).
- 로그인은 데스크탑이 발급한 1회용 코드(E17→E18). CLI 는 시작 시 `/me` 계정이 저장된 로그인과 같은지 확인한다.
- worktree·GitHub 로직은 `@minmo/core` 를 데스크탑과 공유한다. 원격의 생성 후 스크립트는 `postCreateScriptPosix`(sh).
- **로컬 모드**(`minmo mode local`, 명시 전환·기본은 서버 모드): 역터널·로그인 없이 쓴다. 설정·보일 저장소는 기본값 ← 서버 사본(서버 모드에서 받은 값) ← 로컬 전역 ← 로컬 조직 ← 로컬 프로젝트로 계산하고, 로컬 값은 서버로 올리지 않는다. 검증 규칙은 서버와 같다(`@minmo/core` settings). 메모는 서버 모드 전용, GitHub REST 는 gh·`GITHUB_TOKEN` 만(서버 토큰 미사용). 서버 계약 변경 없음.
- **Windows**(v0.2.0): CLI 가 Windows 에서도 동작한다. 터미널은 worktree 에서 새 PowerShell(세션 유지 없음), 생성 후 스크립트는 `postCreateScript`(PowerShell), 삭제 시 정리는 실행 경로·명령줄 기준(`taskkill /T /F`), 서버 모드는 `MINMO_SERVER`(TCP) 필수, 설정 폴더는 `%APPDATA%\minmo`.

### 서버 내장 (v0.3.0, 후속 추가)
- 서버는 데스크탑 설치 파일에 사이드카로 들어가 앱과 함께 실행된다. 서버 env 는 데스크탑이 채운다: 포트(기본 8787, loopback)·DB(앱 데이터 폴더)·토큰 키(첫 실행에 생성, OS 키체인)·OAuth Client ID(설정 파일)/Secret(키체인, 쓰기 전용). 데스크탑 **서버 설정** 화면에서 바꾸며, 바뀌면 서버를 다시 시작한다.
- 정상 종료는 stdin 닫기(`MINMO_STOP_ON_STDIN_CLOSE=1`), 앱이 비정상 종료하면 Job Object 로 함께 끝난다.
- 창을 닫을 때: 매번 묻기(기본)·트레이로 최소화(서버 유지)·종료 중 사용자가 고른다. 서버 계약 변경 없음.

## 비즈니스 규칙
- 조직 목록 = 개인 계정(최상단) + `/user/orgs`. 프로젝트 = 저장소, 이슈 = GitHub Issue(PR 제외)
- 모든 저장소 노드의 첫 행은 "기타" 고정 이슈. GitHub에 존재하지 않으며 삭제·닫힘 불가
- GitHub 호출은 `gh auth status` 성공 시 `gh api`/`gh pr create`, 실패 시 서버 `/me/github-token`으로 REST 직접 호출
- 설정 해석: `project.field ?? org.field ?? global.field`. 개인 계정 저장소의 org scope는 owner = 사용자 login
- 이슈 열기 순서: effective 조회 → mainClonePath에 clone 없으면 clone → `fetch origin` → 템플릿으로 브랜치명 계산 →
  원격에 같은 브랜치 있으면 추적, 없으면 default_branch에서 생성 → `git worktree add <worktreePath 해석값>` →
  postCreateScript가 비어 있지 않으면 worktree cwd에서 실행
- 기타 열기: 브랜치 = `etcBranchName`, 같은 순서로 생성
- `{slug}` = 이슈 제목을 소문자 kebab-case(ASCII 외 문자 제거, 최대 40자, 비면 `issue`)
- 스크립트 실행 환경: 플랫폼 기본 셸(Windows `powershell`, 그 외 `/bin/sh`), 환경 변수
  `MINMO_OWNER` `MINMO_REPO` `MINMO_BRANCH` `MINMO_ISSUE_KEY` `MINMO_ISSUE_NUMBER` `MINMO_WORKTREE` `MINMO_MAIN_CLONE` `MINMO_DEFAULT_BRANCH`
- 스크립트 종료 코드 ≠ 0 → worktree 유지, 로그 패널 실패 표시, [다시 실행] 제공. 자동 타임아웃 없음, [취소]로 프로세스 트리 종료
- 스크립트는 worktree 생성 시 1회만 자동 실행. 기존 worktree를 다시 열 때는 실행하지 않음(수동 [다시 실행]만)
- PR 생성: base = default_branch, title 기본값 = 이슈 제목, body에 `Closes #{number}` 자동 삽입, 기본 draft. 기타는 Closes 없음, title 비움
- 브랜치에 이미 열린 PR이 있으면 생성 대신 해당 PR 링크를 연다
- 닫힌 이슈는 배지만 표시. worktree 삭제는 사용자 조작으로만, 미커밋 변경·미push 커밋이 있으면 확인 후 진행
- 서버 데이터(설정·메모)는 user_id로 격리. 다른 사용자의 레코드는 404

## DB 변경 (SQLite, 신규)
- [ ] `users(id, github_id UNIQUE, login, avatar_url, access_token_enc, created_at)`
- [ ] `sessions(id, user_id FK, token_hash UNIQUE, expires_at, created_at)`
- [ ] `settings(user_id, scope TEXT CHECK(scope IN ('global','org','project')), owner TEXT NOT NULL DEFAULT '', repo TEXT NOT NULL DEFAULT '',
      branch_template, etc_branch_name, worktree_path, main_clone_path, post_create_script, updated_at,
      PK(user_id, scope, owner, repo))` — global 행은 사용자 생성 시 기본값으로 insert
- [ ] `issue_notes(user_id, owner, repo, issue_key, body, updated_at, PK(user_id, owner, repo, issue_key))`

## Breaking Changes
- 없음(신규)

## 정상 흐름
| ID | 시나리오 | 보장되는 결과 | HTTP |
|----|---------|--------------|------|
| AC-01 | 로그인 버튼 → 브라우저 승인 | `/auth/github/callback`이 `minmo://auth?session=…`로 302, 데스크탑이 세션을 keychain에 저장하고 `/`로 이동 | 302 |
| AC-02 | 세션으로 `/me` 호출 | `{id, githubLogin, avatarUrl}` 반환 | 200 |
| AC-03 | 메인 진입 | 트리에 개인 계정이 첫 노드, 이어서 조직들. 저장소 펼치면 ★기타 + 이슈(open, 그리고 closed 중 로컬 worktree 있는 것) | — |
| AC-04 | 새로고침 클릭 | 트리 재조회, 로컬 worktree 존재 여부(●) 갱신 | — |
| AC-05 | 전역 기본 설정에서 미clone 저장소의 이슈 #42 "Add login" 열기 | `~/minmo-workspaces/<owner>/<repo>/_main` clone → 브랜치 `issue/42-add-login` 생성 → worktree `~/minmo-workspaces/<owner>/<repo>/issue--42-add-login` 생성, 상단 바에 브랜치 표시 | — |
| AC-06 | 이미 worktree 있는 이슈 열기 | 생성·스크립트 실행 없이 해당 worktree로 전환 | — |
| AC-07 | ★기타 열기 | 브랜치 `etc`(설정값) worktree 생성/전환 | — |
| AC-08 | 터미널 탭 | worktree 경로를 cwd로 하는 PTY, 입력·출력·리사이즈 동작, 이슈 전환 시 세션 유지 | — |
| AC-09 | 변경 탭에서 파일 선택 → 메시지 입력 → 커밋 | 선택 파일만 스테이징·커밋, 목록 갱신, 커밋 해시 표시 | — |
| AC-10 | push 클릭 | `git push -u origin <branch>` 성공, 미push 카운트 0 | — |
| AC-11 | PR 클릭(이슈 #42) | draft PR 생성, body에 `Closes #42`, 생성 후 URL 표시·열기 | — |
| AC-12 | 메모 탭 입력 후 1초 정지 | `PUT notes` 호출, 응답 `updatedAt` 표시. 재로그인 후에도 동일 본문 | 200 |
| AC-13 | 프로젝트 설정에서 브랜치 템플릿만 `feat/{number}`로 저장, 나머지 비움 | PUT 200, effective의 branchTemplate 출처 `project`·값 `feat/{number}`, 나머지 필드 출처는 상위(org 또는 global). 이후 새 이슈 브랜치가 `feat/42` | 200 |
| AC-14 | 닫힌 이슈 worktree에서 "worktree 삭제" | 변경·미push 없으면 `git worktree remove` + 로컬 브랜치 삭제, ● 배지 제거 | — |
| AC-15 | 조직 설정에 `worktreePath = ~/work/{owner}/{repo}/{key}` 저장 후 하위 저장소 이슈 #42 열기 | worktree가 `~/work/<owner>/<repo>/42`에 생성. 프로젝트 설정 폼의 worktreePath placeholder에 "상속: ~/work/{owner}/{repo}/{key}" 표시 | — |
| AC-16 | 조직 설정 postCreateScript = `npm ci` 후 새 이슈 열기 | worktree add 뒤 스크립트가 worktree cwd에서 실행, 로그 패널에 stdout/stderr 스트리밍, 종료 코드 0이면 "완료" 표시 | — |

## 엣지 케이스
| ID | 케이스 | 기대 동작 | 참조 구현 | HTTP |
|----|--------|----------|----------|------|
| EC-01 | gh 미설치 또는 `gh auth status` 실패 | REST 폴백으로 동일 결과, 트리 상단에 "gh 미사용(REST)" 표시 | - | — |
| EC-02 | GitHub 토큰 만료·철회(REST 401) | 로그인 화면으로 이동, 기존 세션 폐기 | - | 401 |
| EC-03 | 세션 없이/만료된 세션으로 서버 API 호출 | `{error:"unauthorized"}` | - | 401 |
| EC-04 | OAuth callback의 state 불일치·만료 | 오류 페이지, 세션 미발급 | - | 400 |
| EC-05 | 다른 사용자의 settings/notes 키 접근 | 존재하지 않는 것으로 처리 | - | 404 |
| EC-06 | 템플릿에 `{number}` 없음 / ref 금지 문자 | `{error:"invalid_template", field}` | - | 400 |
| EC-07 | notes PUT의 `baseUpdatedAt`이 서버 값보다 오래됨 | 서버 본문 반환, 데스크탑은 "다른 기기에서 수정됨 — 덮어쓰기/불러오기" 선택 | - | 409 |
| EC-08 | 원격에 템플릿 브랜치가 이미 존재 | 새로 만들지 않고 원격 추적 브랜치로 worktree 생성 | - | — |
| EC-09 | worktree 경로가 이미 존재하지만 git에 등록되지 않음 | 생성 중단, 경로 표시 후 "다른 이름 사용/취소" | - | — |
| EC-10 | clone/fetch 네트워크 실패 | 진행 로그에 stderr 표시, 부분 생성물 정리(worktree 미등록), 스크립트 미실행 | - | — |
| EC-11 | 저장소 push 권한 없음(GitHub 403) | push/PR 버튼 오류 메시지, fork 제안 없음(범위 외) | - | — |
| EC-12 | push 거절(non-fast-forward) | 오류 전문 표시, force push 자동 수행 금지 | - | — |
| EC-13 | 브랜치에 열린 PR이 이미 있음 | 생성 대신 기존 PR URL 열기 | - | — |
| EC-14 | ★기타에서 PR 생성 | `Closes` 없이 생성, title 입력 필수 | - | — |
| EC-15 | worktree 삭제 시 미커밋 변경 또는 미push 커밋 존재 | 각 항목 개수를 담은 경고, 확인해야 진행 | - | — |
| EC-16 | ★기타 worktree 삭제 시도 | 메뉴 비활성(툴팁 "고정 이슈는 삭제할 수 없음") | - | — |
| EC-17 | 서버 미연결 | OfflineBanner, 메모·설정 편집 비활성(마지막 읽기 캐시 표시). 이슈 열기는 마지막으로 받은 effective 설정 캐시로 진행, 캐시 없으면 "서버 연결 필요" 안내. GitHub·git·터미널은 정상 | - | — |
| EC-18 | GitHub rate limit(403/429) | 재시도 가능 시각 표시, 자동 재시도 없음 | - | — |
| EC-19 | postCreateScript 종료 코드 ≠ 0 | worktree 유지, 로그 패널 실패 표시 + [다시 실행]. 이슈는 열린 상태 | - | — |
| EC-20 | worktreePath에 `{branch}`·`{key}` 모두 없음 / mainClonePath에 `{branch}`·`{key}` 포함 | `{error:"invalid_path_template", field}` | - | 400 |
| EC-21 | 스크립트 실행 중 [취소] | 프로세스 트리 종료, 로그에 "취소됨", worktree 유지 | - | — |
| EC-22 | 전역 PUT에 null 필드 | `{error:"global_requires_all_fields", field}` | - | 400 |
| EC-23 | 해석된 worktree 경로가 mainClonePath와 같거나 그 하위 | 생성 중단, "worktree 경로가 메인 clone과 겹침" 표시 | - | — |
| EC-24 | 조직/프로젝트 설정의 경로 변경 후 기존 worktree | 기존 worktree는 이동하지 않음. ● 판정은 로컬에 보관한 `이슈 key → 생성 당시 경로` 맵으로 유지하고, 새 경로와 다르면 "경로 변경됨" 배지 표시 | - | — |

## 결정 로그
| ID | 항목 | 결정 | 근거 |
|----|------|------|------|
| D-01 | 작업 유형 | 생성 | 사용자 답(R1) |
| D-02 | 도메인 | fullstack | 데스크탑+서버 (R4~R5) |
| D-03 | 목적 | 개인 개발 워크플로우 자동화 | R2 |
| D-04 | 서버 언어 | Go | R2 |
| D-05 | 범위 | 구상 전체 → 로드맵 + Phase 1 상세 | R2, R5 |
| D-06 | 기능 목록 | git 보조, 작업 기록(메모), 단축어, 그 외 | R3 |
| D-07 | 제품 형태 | Orca 같은 독자 앱 신규 제작 | R4 |
| D-08 | 계층 | 조직 > 프로젝트 > 이슈 | 사용자 서술 |
| D-09 | "기타" | 프로젝트별 고정 이슈 1개, 기본 브랜치와 별개 | 사용자 서술 |
| D-10 | 이슈↔git | 이슈 1개 = 브랜치 + worktree 1개 | R4 |
| D-11 | 데이터 출처 | GitHub (org/개인=조직, repo=프로젝트, Issue=이슈) | R4, R7 |
| D-12 | 플랫폼 | 모바일·데스크탑 모두 | 사용자 서술 |
| D-13 | 연동 | 클라우드 서버 동기화 | R4 |
| D-14 | 스택 | Go 서버 + Tauri 데스크탑 + RN 모바일 | R5 |
| D-15 | 이슈 내 기능 | 터미널, git 변경·커밋·PR, 메모 | R5 |
| D-16 | 모바일 범위 | 조회 + 메타데이터 편집 + 데스크탑 원격 제어 (Phase 3) | R5 |
| D-17 | Phase 1 | 로그인·계층·worktree·터미널 + git 커밋·PR·메모 | R6 |
| D-18 | 설정 모델 | 전역 → org → 프로젝트 3단계 상속. 항목: 브랜치 템플릿, 기타 브랜치명, worktree 경로 템플릿, 메인 clone 경로 템플릿, 생성 후 스크립트. 기본 `issue/{number}-{slug}` / `etc` | R6, R10(수정 1) |
| D-19 | 인증 | GitHub OAuth(PKCE) + 필요 시 자동 clone | R6 |
| D-20 | 구조 | 모노레포 | R6 |
| D-21 | DB | SQLite | R6 |
| D-22 | GitHub 호출 | gh 우선, 폴백 = 서버 발급 OAuth 토큰으로 REST. 서버 캐시 없음 | R9 |
| D-23 | 메모·설정 저장 | 서버 SQLite(모바일 공유) | R9 |
| D-24 | 정리 정책 | 닫힘 표시만, 삭제 수동+경고, 기타 삭제 불가 | R7 |
| D-25 | 조직·기타 PR | 개인 계정 포함, 기타 PR 허용(Closes 없음) | R7 |
| D-26 | 완료 기준 | 단위 + API E2E(모킹) + 데스크탑 수동, 서버 로컬 실행, 커밋+draft PR | R7 |
| D-27 | 레이아웃 | 3분할 트리 + 탭 | R9 |
| D-28 | 생성 후 스크립트 | worktree add 완료 후 worktree cwd에서 실행. 실패해도 worktree 유지, 로그 표시 | R10(수정 1) |
| D-29 | 설정 저장 위치 | 서버 SQLite, 경로는 `~`·변수 치환으로 기기 차이 흡수 | R10(수정 1) |
| D-30 | 상속 규칙 | 하위 값 null → 상위 값 사용, 전역은 앱 기본값으로 항상 채워짐 | R10(수정 1) |

## Assumption
- A-01 데스크탑 프론트는 React + TypeScript(Vite) — RN과 `packages/` 공유를 위해. 근거: D-14
- A-02 터미널은 Tauri Rust 측 `portable-pty` + 프론트 `xterm.js`. 근거: D-15, Tauri 선택
- A-03 서버 기본 주소 `http://127.0.0.1:8787`, 딥링크 스킴 `minmo://`. 근거: 로컬 실행(D-26)
- A-04 서버가 GitHub 토큰을 암호화 보관하고 `/me/github-token`으로 데스크탑에 전달, 데스크탑은 OS keychain 저장. 근거: D-22 REST 폴백에 토큰 필요
- A-05 전역 기본 경로 `~/minmo-workspaces/{owner}/{repo}/{branch}`, 메인 clone `~/minmo-workspaces/{owner}/{repo}/_main`. 근거: D-18
- A-06 브랜치명의 `/`는 worktree 디렉터리명에서 `--`로 치환. 근거: 중첩 디렉터리 회피
- A-07 PR은 기본 draft(토글 가능). 근거: 사용자의 common:commit-pr 기본값이 draft
- A-08 커밋 메시지는 사용자가 직접 작성(자동 생성은 범위 외). 근거: R3 "git 보조" 상세 미지정
- A-09 메모는 이슈당 마크다운 문서 1개(여러 노트 아님). 근거: D-23 단순화
- A-10 트리에 closed 이슈는 로컬 worktree가 있는 것만 표시. 근거: D-24 "표시만"
- A-11 단축어 실행 기능은 Phase 1 선택에 없어 로드맵 후속으로 배치. 근거: D-06 vs D-17
- A-12 메인 clone 위치도 설정 항목(mainClonePath)으로 분리 — worktreePath만으로는 `_main` 위치를 정할 수 없음. 근거: D-18
- A-13 스크립트 셸 = 플랫폼 기본(Windows powershell / 그 외 sh), 셸 선택 설정은 두지 않음. 근거: D-28
- A-14 스크립트는 worktree 생성 시 1회 자동 실행, 재실행은 수동. 근거: D-28
- A-15 스크립트 자동 타임아웃 없음(취소 버튼만). 근거: D-28
- A-16 EC-24의 "경로 변경됨" 배지를 위해 데스크탑 로컬에 `이슈 key → 생성 당시 경로` 맵을 보관. 근거: D-29(경로가 설정 변경으로 달라질 수 있음)

## 미결
- 없음
