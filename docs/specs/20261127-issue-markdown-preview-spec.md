# Spec: 이슈 탭 — 마크다운 본문 미리보기

- 상태: 구현 완료
- 유형·도메인: 화면 수정 · frontend
- 작성: 2026-11-27

### 작업 계약
- 대상: kangmomin/minmo-cli, worktree `issue--116-issue`, 브랜치 `issue/116-issue`(base `main`), 이슈 #116. 화면: `desktop/src/features/issue/WorkTabs.tsx` 의 작업 탭.
- 기준: 이슈 #116 > 사용자 결정 D-01~D-03(아래). 참조 구현은 아래 "참조 구현".
- 범위: [이슈] 탭 추가 + GitHub 이슈 본문 마크다운 렌더링(GFM, 줄바꿈), 저장·새로고침 후 갱신.
  / 제외: 등록·수정 대화상자의 작성/미리보기 전환, 댓글, 이미지 직접 표시(CSP 변경), `#123`·`@user` 자동 링크, 탭 안에서 본문 편집, raw HTML 렌더(`<details>`·`<img>` 등), VERSION 올리기.
  / 한계: GitHub 웹·다른 창에서 바뀐 본문은 트리 [새로고침]으로 갱신한다(탭 캐시는 `staleTime: Infinity`, 창마다 QueryClient 가 따로다).
- 완료: vitest · Playwright(Tauri mock) · build · typecheck · lint 통과. 논리 단위 커밋 + draft PR. README 절 추가, 이 Spec 문서 커밋.
- 승인: D-01~D-03 (2026-11-27 대화), 확정된 결정 A-1~A-7 (2026-11-27 Plan 승인). 구현·커밋·push·draft PR 은 start-workflow 에서 한다.
- 미결: 없음

## 기능 목표
지금 앱은 GitHub 이슈 본문을 렌더링해서 보여 주는 곳이 없다. 본문은 [이슈 수정] 대화상자의 Textarea 에서 원문으로만 보인다.
작업 영역의 탭(터미널·변경·파일·메모)에 **[이슈] 탭**을 더하고, 고른 GitHub 이슈의 본문을 마크다운으로 렌더링해 읽기 전용으로 보인다.

## 현재 상황 (As-Is)
| 파일 | 역할 | 수정 필요 |
|------|------|----------|
| `desktop/src/features/issue/WorkTabs.tsx` | 작업 탭 4개(Radix Tabs) | [이슈] 트리거·패널 추가 |
| `desktop/src/store/ui.ts:11` | `WorkTab` 유니언, `tab` persist(창별) | `'issue'` 추가 |
| `desktop/src/lib/queryKeys.ts` | `githubIssue`(수정 대화상자, gcTime 0) | `githubIssueBody` 키 추가 |
| `desktop/src/features/issue/useIssueManage.ts:67` | `updateGitHub` — `updateIssue` 응답에 본문 없음 | 본문 저장 시 탭 캐시 갱신 |
| `desktop/src/index.css` | Tailwind v4, typography 플러그인 없음 | `.markdown` 스타일(`@layer components`) |
| `desktop/package.json` (+ 루트 `package-lock.json`) | 의존성 | `react-markdown`, `remark-gfm`, `remark-breaks` |
| `README.md` | 기능 절 | `## 이슈 탭` 절 추가 |

### 참조 구현
- `features/issue/EditIssueDialog.tsx:57-89` `GitHubEditBody` → `github.getIssue` 조회, 로딩 문구, `githubErrorMessage` + [다시 시도], "한 번 받은 뒤 실패해도 내용 유지".
- `features/changes/ChangesTab.tsx:173-179` → 링크 `onClick` 에서 `preventDefault` + `tauri.openUrl(url)`.
- `features/notes/NotesTab.tsx:37-41` → 내용 영역이 `tabIndex` 0 + `focus-visible:ring-inset` 링, 패널은 -1 (AX-19, CR-20).
- `features/tree/useTree.ts:18,43,161` → GitHub 조회는 `staleTime: Infinity, retry: false`(+ `retryOnMount: false`), 트리 [새로고침]이 `queryKeys.githubAll`(`['github']`) 전체를 무효화.
- `features/tree/useTree.ts:76-82` `upsertIssueCache` → 응답으로 캐시를 직접 고치는 패턴(`setQueryData`, 캐시가 없으면 그대로).
- `store/repos.ts:16` `isLocalOwner` → 로컬 저장소 작업 판별(`useIssueManage.ts:28` 가 같은 방식으로 쓴다).

## 변경 사항 (To-Be)
1. **새 파일 `desktop/src/features/issue/IssueTab.tsx`** — export 는 `IssueTab` 하나(react-refresh 규칙). 모듈 안 컴포넌트: `IssueTab`, `GitHubIssueBody`, `MarkdownLink`, `MarkdownImage`, `MarkdownTable`.
   - `IssueTab({ target })` — 바깥 스크롤 영역이 `tabIndex` 0 + 포커스 링(`focus-visible:ring-inset`).
     - `target.number === null` → "★기타에는 이슈 본문이 없습니다." (조회 없음)
     - `isLocalOwner(target.owner)` → "로컬 저장소의 작업에는 본문이 없습니다." (조회 없음)
     - 그 외 → `GitHubIssueBody`
   - `GitHubIssueBody` — `useQuery({ queryKey: queryKeys.githubIssueBody(o, r, n), queryFn: () => github.getIssue(o, r, n), staleTime: Infinity, retry: false, retryOnMount: false })`. 다시 조회는 [다시 시도]·트리 [새로고침]으로만 한다.
     - 데이터가 없으면: 오류가 아니면 "불러오는 중…", 오류면 `role="alert"` 로 `githubErrorMessage(error)` + [다시 시도]. [다시 시도]는 먼저 포커스를 내용 영역으로 옮긴 뒤 `refetch()` 한다(`disabled={isFetching}` — 버튼이 사라져도 포커스를 잃지 않게).
     - 본문이 비었거나 공백·HTML 주석(`<!-- -->`)뿐이면 "본문이 없습니다."
     - 그 외 → `<div className="markdown"><Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={…} skipHtml>`. 받은 뒤 다시 조회가 실패해도 받은 본문을 계속 보인다.
   - `MarkdownLink` — `href` 가 `/^https?:/i` 이면 `<a>` + `onClick` 에서 `preventDefault` 후 `tauri.openUrl(href)`. 아니면 `<span>` 글자.
   - `MarkdownImage` — `<img>`·링크 없이 글자 "이미지: {alt}".
   - `MarkdownTable` — `<div tabIndex={0} role="group" aria-label="표" className="overflow-x-auto …">` 로 감싼다. 넓은 표를 키보드로 가로 스크롤한다(랜드마크 이름이 겹치지 않게 region 대신 group).
2. **`lib/queryKeys.ts`** — `githubIssueBody: (owner, repo, number) => ['github', 'issueBody', owner, repo, number]`. 수정 대화상자의 `githubIssue` 와 따로 둔다(대화상자는 열 때마다 새로 받아야 한다, #64). `['github']` 접두라 트리 [새로고침]이 같이 다시 받는다.
3. **`store/ui.ts`** — `WorkTab = 'terminal' | 'changes' | 'files' | 'notes' | 'issue'`. persist 버전·migrate 변경 없음(`merge` 가 tab 을 검사하지 않음, 값 추가만).
4. **`WorkTabs.tsx`** — 메모 뒤에 `<TabsTrigger value="issue">이슈</TabsTrigger>`, `<TabsContent value="issue" tabIndex={-1}><IssueTab key={id} target={target} /></TabsContent>`. 내용 영역이 Tab 정지점이므로 패널은 -1(AX-19). worktree 상태와 무관하게 보인다. Radix 기본(forceMount 없음)이라 탭이 보일 때만 마운트·조회한다.
5. **`useIssueManage.ts` `updateGitHub`** — `updateIssue` 응답에는 본문이 없어 보낸 본문으로 탭 캐시를 고친다(`upsertIssueCache` 와 같은 방식). 본문을 보냈으면:
   - 먼저 `cancelQueries` 로 그 키의 진행 중인 조회를 취소한다. 옛 조회가 새 본문을 덮지 않고, 끝나지 않는 첫 조회를 다시 쓰지 않는다(TanStack Query 는 데이터가 없으면 `invalidateQueries` 가 진행 중인 조회를 취소하지 않고 재사용한다).
   - 탭 캐시에 본문이 있으면 → `setQueryData` 로 새 본문을 넣는다. 다시 조회하지 않는다.
   - 없으면(탭을 안 열었거나 첫 조회 중) → `invalidateQueries`. 첫 조회 중이었으면 저장 뒤 값으로 다시 받는다. 탭을 안 열었으면 아무 일도 없다.
6. **`index.css`** — `@layer components { .markdown … }`: 글자 크기·줄 간격, 블록 간격, h1~h6, 목록, 체크리스트(`ul.contains-task-list`), 링크, 인라인 코드(`:not(pre) > code`), 코드 블록(가로 스크롤 없이 줄바꿈), 인용, 표, 구분선. 테마 토큰만 써서 ghostty·black·light 모두 맞춘다. table 에 `display:block` 을 쓰지 않는다.
7. **의존성** — `react-markdown` ^10.1.0, `remark-gfm` ^4.0.1, `remark-breaks` ^4.0.0 (`desktop/package.json`).
8. **문서** — README `## 이슈 탭` 절.

상태 설계: 서버 상태는 React Query `githubIssueBody` 키 1개(본문). 전역 UI 는 `tab` 값에 `'issue'` 추가. 컴포넌트 로컬 상태 없음(`ref` 하나).

## 정상 흐름
| ID | 시나리오 | 보장되는 결과 |
|----|---------|--------------|
| AC-01 | GitHub 이슈를 고르고 [이슈] 탭을 누른다 | `getIssue` 로 본문을 받아 마크다운으로 렌더링한다: 제목(heading), 목록, 굵게·기울임, 인라인 코드·코드 블록, 인용, 구분선. 문단 안의 줄바꿈 한 번은 줄바꿈(`<br>`)으로 보인다(GitHub 과 같음) |
| AC-02 | 본문에 GFM 요소가 있다 | 표(table), 체크리스트(읽기 전용 checkbox), 취소선(del), 맨 URL 자동 링크를 렌더링한다 |
| AC-03 | 본문의 http/https 링크(대소문자 무관)를 누른다 | 앱 화면은 이동하지 않고(`preventDefault`) `tauri.openUrl(href)` 로 외부 브라우저에서 연다 |
| AC-04 | [이슈] 탭에서 옛 본문을 보는 중에 [이슈 수정]으로 본문을 바꿔 저장한다 | 다시 조회하지 않고 같은 탭이 새 본문을 보인다. 탭이 아직 첫 조회 중이면 저장 뒤 다시 받아 새 본문을 보인다("불러오는 중…"에 멈추지 않음) |
| AC-05 | 트리 [새로고침]을 누른다 | [이슈] 탭이 본문을 다시 받는다(탭이 안 보이면 다음에 열 때). 단, 탭이 안 보이는 동안 조회 오류 상태였으면 다시 열어도 자동으로 받지 않고 EC-14 대로 [다시 시도]로 받는다 |

## 엣지 케이스
| ID | 조건 | 보장되는 결과 |
|----|------|--------------|
| EC-01 | 본문이 비었거나 공백·HTML 주석(`<!-- -->`)뿐 | "본문이 없습니다." |
| EC-02 | 조회 중 | "불러오는 중…" |
| EC-03 | 조회 실패 | `role="alert"` 로 `githubErrorMessage` 문구 + [다시 시도] → 누르면 포커스가 내용 영역으로 가고 다시 조회 |
| EC-04 | ★기타(`number === null`) | "★기타에는 이슈 본문이 없습니다.", `getIssue` 호출 없음 |
| EC-05 | 로컬 저장소 작업(`isLocalOwner`) | "로컬 저장소의 작업에는 본문이 없습니다.", `getIssue` 호출 없음 |
| EC-06 | 본문에 raw HTML(`<script>alert(1)</script>`, `<img src=x onerror=…>`, `<!-- 안내 -->`, 빈 줄로 나눈 `<details>`…`</details>`) | `<script>`·`<img>` 요소가 없고 태그·주석 글자("안내", "`<details>`")도 없다. 빈 줄로 나눈 안쪽 마크다운 글자는 보인다 |
| EC-07 | http/https 가 아닌 링크(`javascript:`, 상대 경로, `#anchor`) | 링크(`<a>`)가 아니라 글자로 보이고 `openUrl` 호출 없음 |
| EC-08 | 이미지 `![alt](https://…)` 와 배지 `[![CI](https://…/b.svg)](https://…/actions)` | `<img>` 없이 글자 "이미지: alt". 배지는 링크 하나만 있고(`<a>` 중첩 없음) 누르면 `openUrl` 이 링크 href 로 1번 |
| EC-09 | [이슈] 탭에서 본문을 본 뒤 다른 곳에서 본문이 바뀌고 [이슈 수정]을 연다 | 대화상자 본문 칸은 새 본문(탭 캐시를 쓰지 않음, #64 유지) |
| EC-10 | 다른 탭을 보고 있다 | 본문을 조회하지 않는다(탭을 열 때 조회) |
| EC-11 | 접근성 | [이슈] 탭은 `tabpanel` "이슈" 와 연결, 패널 `tabIndex=-1`, 내용 영역 `tabIndex=0` + 포커스 링, 표는 포커스 가능한 가로 스크롤 영역 |
| EC-12 | 다른 이슈로 바꾼다 | 바꾼 이슈의 본문을 보인다(이전 본문이 남지 않음) |
| EC-13 | 본문을 받은 뒤 다시 조회(트리 [새로고침])가 실패 | 받은 본문을 계속 보인다 |
| EC-14 | 조회가 실패한 뒤 다른 탭에 갔다가 [이슈] 탭으로 돌아온다 | 자동으로 다시 조회하지 않는다(오류 문구 + [다시 시도] 유지) |

권한·소유권: 해당 없음 — 로그인·소유권 규칙을 바꾸지 않는다. 본문 조회는 기존 `github.getIssue` 를 그대로 쓴다.

## 결정 로그
| ID | 항목 | 결정 | 근거 |
|----|------|------|------|
| D-01 | 미리보기 위치 | 작업 탭에 [이슈] 탭 추가, 읽기 전용 본문 보기 | 사용자 답 |
| D-02 | 파서 | `react-markdown` 10.1.0 + `remark-gfm` 4.0.1 (peer `react>=18` 확인). `rehype-raw` 미사용 | 사용자 답 |
| D-03 | 작업 난이도 | 자동 판정 | 사용자 답 |

## 확정된 결정 (2026-11-27 Plan 승인)
- A-1: 마크다운 이미지 `![alt](url)` 는 `<img>` 로 띄우지 않고 글자 "이미지: {alt}" 로만 보인다(링크 아님 — 배지 `[![x](img)](url)` 에서 `<a>` 중첩을 피한다). Tauri CSP `img-src` 를 바꾸지 않는다.
- A-2: [이슈] 탭은 맨 끝(터미널·변경·파일·메모·**이슈**)에 둔다. 기본 탭은 그대로 터미널.
- A-3: ★기타·로컬 저장소 작업에도 탭은 보이고, 본문이 없다는 안내만 보인다(탭을 숨기면 저장된 탭 값이 빈 화면이 된다).
- A-4: http/https 가 아닌 링크(상대 경로·`#anchor`·`mailto:` 등)는 링크로 만들지 않고 글자로 보인다.
- A-5: GitHub 처럼 줄바꿈 한 번을 줄바꿈으로 보이려고 `remark-breaks` 4.0.0 을 더한다(D-02 에 의존성 1개 추가, 같은 unified 11 생태계). CommonMark 그대로면 두 줄이 한 줄로 붙는다.
- A-6: raw HTML 은 `skipHtml` 로 숨긴다(글자로도 보이지 않음). CommonMark 의 HTML 블록은 **빈 줄까지 통째로** 하나다 — `<details>\n<summary>로그</summary>` 처럼 빈 줄 없이 이어진 글자("로그")도 함께 숨는다. 빈 줄로 나눈 마크다운만 남는다.
- A-7: GitHub 에 끌어다 놓은 이미지는 본문에 `<img …>` HTML 로 저장된다 → A-6 에 따라 **표시 없이 숨는다**(A-1 의 "이미지: alt" 도 나오지 않음). 이미지만 있는 본문은 빈 영역으로 보인다("본문이 없습니다." 아님 — 내용이 있으므로).

## 미결
- 없음
