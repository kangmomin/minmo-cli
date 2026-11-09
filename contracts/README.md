# contracts/ — 공용 계약 fixture (오케스트레이터 소유)

서버(Go)와 클라이언트(TS)가 **같은 fixture**를 읽어 Integration Contract v2.4를 고정한다.
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
| `errors.json` | 공통 에러 body 예시 · CT-04/08/10/11/19/20/27/28/29 |
| `template-vectors.json` | 템플릿 치환 golden · CT-34 (TS) / Go `validate_test`는 `refCases`·`branchCases[].expected` 소비 |
