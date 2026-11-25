# Spec: E2E 테스트 큐 제거

- 상태: 구현 준비 완료
- 유형·도메인: 수정 · fullstack (React 화면 + Tauri Rust 명령)
- 작성: 2026-11-25, ready-for-impl 인터뷰 (질문 3회)

### 작업 계약
- 대상: kangmomin/minmo-cli, worktree `issue--111-e2e-test-queue`, 브랜치 `issue/111-e2e-test-queue`, 이슈 #111. PR #108(#92, merge `ecf87f9`)이 바꾼 파일 36개.
- 기준: 이슈 #111 > 인터뷰 결정 D-01~D-10. 되돌림 기준은 `git diff ecf87f9^1 ecf87f9`. 그 뒤 main 변경은 버전 올리기(`07f9e9c`)뿐이다.
- 범위: E2E 큐 기능 전부 제거, 남은 데이터 정리 3종(공유 파일·로컬 설정·결과 폴더), README 절 삭제, 이전 Spec에 폐기 표시
  / 제외: `docs/releases/v0.30.0.md` 수정, VERSION 올리기, 실제 Tauri 앱 수동 확인
- 완료: vitest · Playwright(Tauri mock) · `cargo test` · build · typecheck · lint 통과, 커밋 + draft PR
- 승인: 이 Spec 확정까지. 구현·커밋·push·PR은 start-workflow에서 한다(완료 범위는 사용자가 R1에서 "커밋 + draft PR"로 지정).
- 미결: 없음

## 기능 목표
앱을 이 버전으로 올리면 E2E 테스트 큐 화면·실행기·모델 목록 조회가 없어지고, 이전 버전이 남긴 E2E 데이터도 지워져야 한다.

## 현재 상황 (As-Is)
| 파일 | 역할 | 수정 필요 |
|------|------|----------|
| `desktop/src/features/e2eQueue/*` (11개) | 큐 store·실행기·역할·모델 파서·대화상자·테스트 | 삭제 |
| `desktop/e2e/e2eQueue.spec.ts` | Playwright E2E | 삭제 |
| `desktop/src/features/issue/IssueHeader.e2eQueue.test.tsx` | [E2E 큐에 추가] 테스트 | 삭제 |
| `desktop/src-tauri/src/commands/agent_models.rs` | `agent_models_raw` 명령 | 삭제 |
| `desktop/src/app/Workspace.tsx:13-15,57,89,115,228` | 버튼·대화상자·runner 연결 | 되돌림 |
| `desktop/src/features/issue/IssueHeader.tsx:12,31-37,93-106` | [E2E 큐에 추가] 버튼·안내 | 되돌림 |
| `desktop/src/features/agents/launchQueue.ts:3-43` (+test) | `taken`·`consumeLaunch`·`cancelLaunch`·`isLaunchPending` | 되돌림 |
| `desktop/src/features/terminal/TerminalTab.tsx:17,500-501` (+test `:1623`) | 입력 직전 `consumeLaunch` 확인 | 되돌림 |
| `desktop/src/store/ui.ts:6-7,79,118,127-129,174,212-229,373,399-400` (+test) | `e2eRoles`·`setE2eRole`·`launchPane` focus 옵션 | 되돌림 + version 2 |
| `desktop/src/store/shared.ts:3-7,111-119,192-203` (+test) | 공유 키 `e2e` 바인딩 | 되돌림 |
| `desktop/src/lib/sshHost.ts:5,24,133-172,393-399` (+test `:271-`) | 원격 `agentModelsRaw` | 되돌림 |
| `desktop/src/lib/tauri.ts:143-144,293-294,344,512` | `AgentModelsKind`·`agentModelsRaw` | 되돌림 |
| `desktop/src/lib/tauri.mock.ts:46,451` 등, `desktop/src/test/fakes.ts:112` | mock 모델 목록 | 되돌림 |
| `desktop/src-tauri/src/lib.rs:11,92`, `commands/mod.rs:1`, `remote.rs:63` | 명령 등록·원격 허용 | 되돌림 |
| `desktop/src-tauri/src/commands/usage.rs:509` | `tool_dir` 가 `pub(crate)` | `fn` 으로 되돌림 |
| `README.md:230-262` | "E2E 테스트 큐" 절 | 삭제 |
| `docs/specs/20261124-e2e-test-queue-spec.md` | 이전 Spec | 상단에 폐기 표시 |

### 참조 구현
- `git diff ecf87f9^1 ecf87f9` → 되돌림의 정답. 공통 파일은 #108 이전 내용으로 되돌린다(그 뒤 다른 변경 없음).
- `desktop/src/store/ui.ts:378-382` → persist `migrate`의 버전 분기 패턴. version 2 분기를 같은 방식으로 추가한다.
- `desktop/src-tauri/src/commands/fs.rs:554-567` (`fs_remove`) / `desktop/src/lib/sshHost.ts:432` → 결과 폴더 삭제에 쓸 로컬·원격 공통 `removePath`. 없는 경로는 성공으로 끝난다.
- `desktop/src-tauri/src/remote.rs:80,85` → 원격 화면도 `listDir`·`removePath`를 이미 쓸 수 있다(허용 목록 변경 불필요).
- `desktop/src/features/issue/useWorktree.tsx:75,134-149` → 작업 폴더가 `ready`가 되는 곳(새 worktree 생성 직후, [열기]·딥링크). 열기 상태는 메모리에만 있어 앱을 시작할 때 저절로 ready 가 되지는 않는다.

## 변경 사항 (To-Be)
1. **삭제:** As-Is 표의 "삭제" 파일.
2. **되돌림:** As-Is 표의 "되돌림" 파일을 #108 이전 동작으로. `launchPane(issueId, keepFirst)` 는 항상 포커스를 요청한다. `takeLaunch` 는 꺼낼 때 지운다.
3. **정리 코드 (신규)**
   - Rust: `remote.rs` `init` 에서 `app.manage(RemoteManager::new(..))` 바로 앞에 `remove_retired_shared` 로 `shared/e2e.json` 이 있으면 지운다(생성자에 부수 효과를 넣지 않음).
   - 화면: `minmo-ui` persist version 1 → 2(한 번 다시 저장하게). `e2eRoles` 키는 `perWindowStorage` 의 `retired` 옵션이 읽을 때 빼고 쓸 때 저장소에서도 지운다(기존 쓰기는 저장된 키를 남긴다). 기존 `version < 1` theme 이동은 유지.
   - 화면(`features/issue/legacyE2eCleanup.ts`, `Workspace` 에서 호출): 이슈 작업 폴더가 `ready` 가 되면 그 이슈의 host ops 로 ① `.minmo` 가 링크가 아닌 폴더일 때만 ② `removePath(path, '.minmo/e2e')` ③ `listDir(path, '.minmo')` 가 비었고 ④ `.minmo/.git` 이 없으면 `removePath(path, '.minmo')`. 확인(①③④)이 실패하면 지우지 않는다. 같은 (호스트, 경로)는 창마다 1회.
4. **문서:** README 절 삭제. 이전 Spec 맨 위에 폐기 표시(A-4).

## 정상 흐름
| ID | 시나리오 | 보장되는 결과 |
|----|---------|--------------|
| AC-01 | 앱을 연다 | 상단 바에 [E2E 큐] 버튼이 없다 |
| AC-02 | 작업 폴더가 ready 인 이슈를 연다 | 이슈 머리줄에 [E2E 큐에 추가] 버튼이 없다 |
| AC-03 | [에이전트 실행]으로 명령을 맡기고 새 패널의 셸이 준비된다 | 명령이 1회 입력된다(#108 이전과 같음) |
| AC-04 | `launchPane` 을 부른다 | 새 패널에 포커스 요청이 간다(focus 옵션 없음) |
| AC-05 | Tauri 명령 목록·원격 허용 목록을 본다 | `agent_models_raw`·`agentModelsRaw` 가 없다 |
| AC-06 | `<설정 폴더>/shared/e2e.json` 이 있는 상태로 앱을 시작한다 | 그 파일이 없어진다 |
| AC-07 | `minmo-ui` 에 version 1 + `e2eRoles` 가 저장된 상태로 앱을 시작한다 | 상태와 다음 저장값에 `e2eRoles` 가 없고 version 은 2다. theme 이동 규칙은 그대로다 |
| AC-08 | 화면이 공유 상태를 맞춘다 | `sharedGet`·`sharedSet` 을 키 `e2e` 로 부르지 않는다 |
| AC-09 | 작업 폴더(로컬·원격)가 ready 가 된다 | `<작업 폴더>/.minmo/e2e/` 가 없어진다 |
| AC-10 | AC-09 뒤 `.minmo/` 가 비었다 | `.minmo/` 도 없어진다 |
| AC-11 | 문서를 본다 | README 에 "E2E 테스트 큐" 절이 없고, 이전 Spec 맨 위에 폐기(#111) 표시가 있다 |

## 엣지 케이스
| ID | 케이스 | 기대 동작 | 참조 구현 |
|----|--------|----------|----------|
| EC-01 | `.minmo/e2e/` 가 없다 | 오류 없이 넘어간다 | `fs.rs:559-561` |
| EC-02 | 결과 폴더 삭제 실패(권한·원격 연결 끊김·심볼릭 링크 거부) | 화면에 알리지 않고 무시한다. 작업 폴더 열기는 그대로 진행. 앱을 다시 시작한 뒤 그 이슈를 다시 열 때 다시 시도 | - |
| EC-03 | `.minmo/` 에 다른 파일이 있다 | `.minmo/` 는 남긴다 | - |
| EC-04 | `listDir(.minmo)` 실패, `.minmo` 가 링크, `.minmo/.git` 있음 또는 확인 실패 | `.minmo/` 는 남기고 무시한다 | - |
| EC-05 | 같은 폴더가 여러 번 ready(다시 열기·여러 창) | 창마다 1회만 시도. 여러 창이 함께 지워도 없는 경로는 성공이라 무해 | `fs.rs:559-561` |
| EC-06 | `shared/e2e.json` 삭제 실패 | 무시하고 앱 시작을 계속한다 | - |
| EC-07 | `shared/e2e.json` 이 없다 | 아무것도 안 한다 | - |
| EC-08 | v0.30 화면(붙은 기기)이 키 `e2e` 를 다시 쓴다 | 파일이 다시 생기지만 읽는 곳이 없다. 다음 앱 시작 때 다시 지운다 | - |

권한·소유권: 해당 없음 — 로그인·소유권 규칙을 바꾸지 않는다. 원격 화면은 이미 허용된 `listDir`·`removePath` 만 쓴다(`remote.rs:80,85`).

## Feature Matrix
| ID | 사용자 흐름 | 프론트 책임 | 백엔드(Rust) 책임 | 완료 조건 |
|----|------------|------------|------------|----------|
| F-01 | E2E 큐 화면 제거 | 버튼·대화상자·runner·store 삭제 | - | AC-01, AC-02 |
| F-02 | 모델 목록 조회 제거 | `tauri.ts`·`sshHost.ts`·mock·fakes 정리 | `agent_models.rs` 삭제, `lib.rs`·`mod.rs`·`remote.rs` 등록 해제, `tool_dir` 비공개 | AC-05 |
| F-03 | 공통 코드 되돌림 | `launchQueue`·`TerminalTab`·`launchPane` | - | AC-03, AC-04 |
| F-04 | 남은 데이터 정리 | persist v2, 공유 키 바인딩 삭제, 결과 폴더 삭제 | `shared/e2e.json` 삭제 | AC-06 ~ AC-10 |

## 결정 로그
| ID | 항목 | 결정 | 근거 |
|----|------|------|------|
| D-01 | 제거 범위 | PR #108 변경 전부 | 사용자 답(R1). 공통 코드 4건 다른 호출자 없음(grep) |
| D-02 | 남은 데이터 | 정리 코드 추가 | 사용자 답(R1) |
| D-03 | 문서 | 이전 Spec 폐기 표시, 릴리스 노트 유지, README 절 삭제 | 사용자 답(R1) |
| D-04 | 완료 범위 | 커밋 + draft PR, 버전 올리기 제외 | 사용자 답(R1) |
| D-05 | 공유 파일 | 앱 시작 때 Rust 가 삭제 | 사용자 답(R3) |
| D-06 | 결과 폴더 | ready 될 때마다, 같은 폴더 창마다 1회. `.minmo/e2e` 는 통째 삭제 | 사용자 답(R3·R4), 구현 Plan 단계 재확인 |
| D-07 | 로컬 설정 | persist version 2 migrate | 사용자 답(R3) |
| D-08 | 검증 | 자동 검증만 | 사용자 답(R3) |
| D-09 | 삭제 실패 | 조용히 무시 | 사용자 답(R4) |
| D-10 | 빈 `.minmo/` | 비었으면 삭제 | 사용자 답(R4) |

## Assumption
- 구현 Plan 에서 더한 결정(A-5~A-10)은 PR 본문에 있다. 이 문서는 그 결과를 반영한 최종 계약이다.
- A-1: `shared/e2e.json` 삭제 실패도 무시한다 — 근거: D-09 와 같은 원칙.
- A-2: 정리 코드는 계속 둔다(지우는 시점을 정하지 않음) — 근거: 지울 시점에 대한 지시 없음.
- A-3: 제거한 기능의 테스트는 함께 지우고, 정리 코드(AC-06 ~ AC-10, EC-01 ~ EC-05)에는 단위 테스트를 새로 쓴다 — 근거: 기존 테스트 관례(`*.test.ts`, `cargo test`).
- A-4: 폐기 표시는 이전 Spec 맨 위 1줄 `> 폐기 (#111, 2026-11-25): 기능을 제거했다. 기록으로만 남긴다.` — 근거: 형식 지시 없음.

## 미결
- 없음
