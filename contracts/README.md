# contracts/ — 공용 계약 fixture (오케스트레이터 소유)

서버(Go)와 클라이언트(TS)가 **같은 fixture**를 읽어 Integration Contract v2.7을 고정한다.
(v2.6: 설정에 `sparsePaths` 추가 — 줄바꿈 구분 상대 디렉터리, `""` = 전체 체크아웃. 전역 PUT 에서 생략·null 이면 저장된 값 유지, 없으면 `""`)
(v2.7: 보일 저장소 E15/E16, 원격 CLI 로그인·세션 E17~E20, 설정 `postCreateScriptPosix` — Linux/macOS(sh) 생성 후 스크립트, `postCreateScript` 는 Windows(PowerShell). 전역 PUT 에서 생략·null 이면 저장된 값 유지)
(v2.8: 설정 `ignoredCopyExclude` — 새 worktree 에 무시된 파일을 가져올 때 뺄 폴더·파일 이름(줄바꿈 구분), `"off"` = 가져오지 않음. 전역 PUT 에서 생략·null 이면 저장된 값 유지, 없으면 기본 제외 목록)
도메인 구현 에이전트는 이 디렉터리와 두 계약 테스트
(`server/internal/httpapi/contract_test.go`, `packages/api-client/src/contract.test.ts`)를 수정하지 않는다.

## 플레이스홀더 규칙 (양쪽 테스트가 동일하게 해석)

| 플레이스홀더 | 일치 조건 |
|-------------|----------|
| `"<id>"` | `^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` |
| `"<ts>"` | `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$` (UTC 밀리초 고정) |
| `"<token>"` | `^[A-Za-z0-9_-]{43}$` (32B base64url, 패딩 없음) |
| `"<string>"` | 임의 문자열 |

## 파일

| 파일 | 대응 엔드포인트 / CT |
|------|---------------------|
| `me.json` | E3 · CT-05 |
| `settings-global-default.json` | E6 · CT-07 |
| `settings-scope-empty.json` | E8/E10 · CT-22 |
| `effective-project-override.json` | E12 · CT-09 |
| `notes-empty.json` | E13 · CT-13 |
| `notes-saved.json` | E14 · CT-14 |
| `notes-conflict.json` | E14 409 · CT-15 |
| `visible-repos-default.json` | E15 (선택 없음 = 전체 표시) · CT-41 |
| `visible-repos-saved.json` | E16 · CT-41 |
| `cli-code.json` | E17 원격 CLI 1회용 로그인 코드 · CT-42 |
| `cli-exchange.json` | E18 코드 → CLI 세션 · CT-42 |
| `sessions.json` | E19 세션 목록(최근 생성 순, current) · CT-42 |
| `errors.json` | 공통 에러 body 예시 · CT-04/08/10/11/19/20/27/28/29 |
| `template-vectors.json` | 템플릿 치환 golden · CT-34 (TS) / Go `validate_test`는 `refCases`·`branchCases[].expected` 소비 |
