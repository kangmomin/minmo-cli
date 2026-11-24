# Spec: E2E 테스트 큐

- 상태: 구현됨(PR 대기)
- 유형·도메인: 추가 · frontend (desktop React + Tauri Rust)
- 작성: 2026-11-24, 이슈 #92 (사용자 확인 8건 D-1~D-8). 아래 [Assumption] 항목은 사용자 확인 전이다.

### 작업 계약
- 대상: kangmomin/minmo-cli, worktree `issue--92-e2e-test-queue`, 브랜치 `issue/92-e2e-test-queue`, 이슈 #92 "e2e test queue".
  `desktop/src/features/e2eQueue/*`(신규), `desktop/src/store/ui.ts`, `desktop/src/store/shared.ts`, `desktop/src/features/agents/launchQueue.ts`,
  `desktop/src/features/terminal/TerminalTab.tsx`, `desktop/src/features/issue/IssueHeader.tsx`, `desktop/src/app/Workspace.tsx`,
  `desktop/src/lib/{tauri.ts,tauri.mock.ts,sshHost.ts}`, `desktop/src/test/fakes.ts`,
  `desktop/src-tauri/src/commands/agent_models.rs`(신규), `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/src/remote.rs`, `README.md`
- 기준: 이슈 #92 본문 > 사용자 확인(결정 D-1~D-8) > 현재 코드.
  참조 구현: 에이전트 실행 `LaunchAgentDialog.tsx`(launchPane + queueLaunch), 상태 추적 `agentStore.ts`·`useAgentTracker.ts`,
  명령 틀 `launch.ts`(buildCommand·quoteArg), 공유 동기화 `store/shared.ts`(agentCommands), 원격 실행 `sshHost.ts`
- 범위: 큐(이슈 단위 작업, 전역 FIFO, 한 번에 1개) / 작업당 3단계 파이프라인 / 역할 설정(CLI·모델·지시문) / 모델 목록 조회(로컬·원격 호스트) / UI(큐 대화상자, 이슈 헤더의 [E2E 큐에 추가])
  / 제외: 서버(Go) 설정 저장·상속, headless 실행, 큐 영속화(앱 재시작 후 복원), 결과 파일 내용 해석·요약, 단계 시간 제한, 동시 실행 2개 이상
- 완료: 아래 AC·EC 충족. 검증 = vitest + Playwright E2E(Tauri mock) + cargo test + 실제 앱에서 수동 1회(로컬 claude).
  README 갱신, 이 Spec 추가. 버전은 올리지 않음. 환경 참고: Windows에서 E2E는 포트 1420 확인 + `CI=1`, 단위 테스트는 cwd=desktop.
- 승인: 사용자 결정 D-1~D-8 (전체 워크플로우 진행 포함)
- 미결: 없음 (아래 [Assumption] 항목은 사용자 확인 대기)

## 기능 목표
이슈를 E2E 큐에 넣으면, minmo가 차례가 된 이슈의 작업 폴더에서 3단계 에이전트(① E2E 실행 → ② 엣지케이스 찾기 → ③ 엣지케이스 기반 테스트)를 터미널 패널로 하나씩 실행하고, 결과 파일로 다음 단계를 넘긴다. 큐는 한 번에 1개 작업만 실행한다.

## 현재 상황 (As-Is)
| 파일 | 역할 | 수정 |
|------|------|------|
| `desktop/src/features/agents/launch.ts` | 명령 틀·quoteArg·buildCommand·defaultPrompt | 재사용(변경 없음) |
| `desktop/src/features/agents/launchQueue.ts` | 패널 준비 후 명령 입력 대기열 | 항목을 `{command, at, taken}` 으로. `takeLaunch` 시그니처 유지, `consumeLaunch`·`cancelLaunch`·`isLaunchPending` 추가 |
| `desktop/src/features/terminal/TerminalTab.tsx` | 꺼낸 명령을 셸 준비 후 입력 | 입력 직전 `consumeLaunch(paneId)` 가 false 면 입력하지 않음(EC-22). 기존 [에이전트 실행] 동작 불변 |
| `desktop/src-tauri/src/remote.rs` | 원격 접속 허용 명령 | `agentModelsRaw` 추가(A-13) |
| `desktop/src/features/agents/LaunchAgentDialog.tsx` | launchPane + queueLaunch | 재사용(변경 없음) |
| `desktop/src/features/agents/agentStore.ts` | 패널별 에이전트 상태 | 읽기만 |
| `desktop/src/store/ui.ts` | agentCommands persist(`minmo-ui`) | `e2eRoles` 추가, `launchPane` 에 `focus` 옵션 |
| `desktop/src/store/shared.ts` | agentCommands 공유 | 별도 키 `e2e` 로 `e2eRoles` 공유 |
| `desktop/src/lib/tauri.ts`·`tauri.mock.ts`·`sshHost.ts`·`test/fakes.ts` | Tauri API / mock / 원격 / 테스트 fake | `agentModelsRaw` 추가 |
| `desktop/src-tauri/src/commands/agent_models.rs` | (신규) 모델 목록 원문 | 새 명령 `agent_models_raw` |
| `desktop/src/app/Workspace.tsx` | 상단 바·대화상자 | [E2E 큐] 버튼·대화상자·runner 마운트 |
| `desktop/src/features/issue/IssueHeader.tsx` | [에이전트 실행] | [E2E 큐에 추가] 추가 |

## 구조 (`desktop/src/features/e2eQueue/`)
| 파일 | 역할 |
|------|------|
| `roles.ts` | 역할 3개, 기본 지시문, 결과 파일 경로, 자리표시 치환, 모델 인자(A-4), 명령 만들기, 저장 값 검증(sanitizeRoles) |
| `models.ts` | 모델 목록 원문 파서(Claude 캐시·Codex·Gemini) |
| `queueStore.ts` | 작업 목록 store(메모리). 전이는 현재 상태·단계가 맞을 때만 적용 |
| `useE2eQueueRunner.ts` | Workspace 에 한 번 마운트. 3초 폴링 한 루프가 작업 시작·단계 시작·단계 판정을 맡는다 |
| `useAgentModels.ts` | 모델 목록 조회(react-query) |
| `E2eQueueDialog.tsx` · `E2eQueueButton.tsx` | 큐 대화상자(작업·역할 설정 탭) · 상단 바 버튼 |

## 결정 로그
| ID | 항목 | 결정 |
|----|------|------|
| D-1 | 큐의 뜻 | 이슈/worktree 작업을 줄 세우고, 작업마다 단계 파이프라인을 돈다 (둘 다) |
| D-2 | 역할 | ① E2E 실행 ② 엣지케이스 찾기 ③ 엣지케이스 기반 테스트. 역할마다 CLI·모델 설정 |
| D-3 | 실행 방식 | 보이는 터미널 패널에서 대화형으로 실행 (기존 에이전트 실행과 같은 방식) |
| D-4 | 모델 | 세 CLI 모두 모델 목록을 가져와 확인·선택 |
| D-5 | 설정 저장 | 클라이언트 저장(`minmo-ui` store) + PC 간 공유 동기화 |
| D-6 | 단계 진행 | 결과 파일 자동: 지시문에 결과 파일 경로를 넣고, 파일이 생기고 에이전트가 working 이 아니면 다음 단계. [다음 단계]로 먼저 넘길 수 있음 |
| D-7 | 패널 | 끝난 단계의 패널은 남김. 다음 단계는 새 분할 패널 |
| D-8 | 작업 범위 | 전체 워크플로우(Spec → Plan → 구현 → 품질 루프 → PR) |

## 추론 항목 ([Assumption] — 사용자 확인 전)
- A-1 [Assumption] 결과 파일 위치: worktree 안 `.minmo/e2e/<jobId>/{1-run,2-edge-cases,3-verify}.md`. 폴더에 `*` 한 줄짜리 `.gitignore` 를 먼저 만들어 git 변경에 안 보이게 함 (worktree 밖은 codex 샌드박스·claude 권한 때문에 쓰기 어려움)
- A-2 [Assumption] 큐는 메모리에만 둠(앱 재시작 시 사라짐). 진행 중 패널이 사라지면(재시작 포함) 실패 처리
- A-3 [Assumption] 큐 시작 조건: 그 이슈의 작업 폴더가 열려 있음(ready). 아니면 그 작업은 실패("작업 폴더가 열려 있지 않습니다")하고 다음 작업으로
- A-4 [Assumption] 모델 인자(`--model <m>` claude / `-m <m>` codex·gemini, 값은 quoteArg): ① 틀에 `{model}` 자리가 있으면 그 자리(빈 값이면 자리와 바로 앞 옵션 제거) ② 틀에 이미 `--model`/`-m` 토큰이 있으면 넣지 않음 ③ 아니면 CLI 이름(claude·codex·gemini, 따옴표·경로·`.cmd/.exe` 무시)과 일치하는 첫 토큰 바로 뒤 ④ 그것도 없으면 `{prompt}`(바로 앞 한 글자 옵션 포함) 앞. 모델 빈 값 = CLI 기본값(인자 없음)
- A-5 [Assumption] 모델 목록 출처: Claude = CLI에 목록 명령이 없어 `$CLAUDE_CONFIG_DIR`(없으면 `~/.claude`)`/cache/model-catalog/` 의 가장 최근 `*-cc.json` 의 `catalog.config.models[]`(`masked-ids.json` 의 ids 제외), 없으면 별칭 `opus·sonnet·haiku`. Codex = `codex debug models`(visibility `list`, priority 순). Gemini = `gemini models list -o json`, 실패하면 `gemini --list-models` 텍스트
- A-6 [Assumption] 모델은 목록에서 고르거나 직접 입력(목록 조회 실패 대비). 입력 패턴 `^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]*$` (`-` 시작 금지 — 옵션 주입 방지)
- A-7 [Assumption] 기본 지시문(편집 가능, [기본값] 복원 버튼). 자리표시: `{issue}`(이슈 번호·제목·주소), `{out}`(이 단계 결과 파일), `{prev}`(앞 단계 결과 파일들)
- A-8 [Assumption] 큐 UI: 상단 바 [E2E 큐] 버튼 → 대화상자(작업 목록 + 역할 설정 탭). 이슈 헤더에 [E2E 큐에 추가]
- A-9 [Assumption] 같은 이슈가 이미 대기/실행 중이면 다시 추가하지 않음(안내)
- A-10 [Assumption] 단계 시작 확인: 단계 패널의 터미널이 110초 안에 뜨지 않으면(이슈를 하나도 고르지 않아 터미널 탭이 마운트되지 않은 경우 등) 작업 실패 "터미널을 띄우지 못했습니다 — 이슈 화면을 열어 두세요". 대화상자에 이 조건 안내
- A-11 [Assumption] [취소]는 아직 입력 안 된 명령을 지우고 작업만 취소. 이미 실행 중인 에이전트는 패널에 남아 계속 돈다(D-7 패널 유지와 일관, 사용자가 패널에서 직접 종료)
- A-12 [Assumption] 큐가 연 패널은 포커스를 옮기지 않는다(사용자가 입력 중인 패널을 뺏지 않게)
- A-13 [Assumption] 원격 PC(브라우저·휴대폰 원격 접속) 화면에서도 모델 목록 조회 허용(읽기 전용 명령)
- A-14 [Assumption] 결과 파일 폴더를 `.gitignore` 로 숨기면 gemini 의 파일 도구가 그 파일을 읽지 않을 수 있음 → 기본 지시문에 "앞 단계 결과({prev})는 셸 명령(cat / Get-Content)으로 읽어라"를 넣음
- A-15 [Assumption] 모델 목록은 사이드바에서 고른 호스트에서 가져옴. 역할 설정 탭에 "목록 출처: <호스트>" 표시. 모델 값은 호스트와 무관하게 저장(다른 호스트에 없는 모델이면 터미널에서 CLI 오류로 보임)

## 정상 흐름 (AC)
- AC-01 이슈 헤더(작업 폴더 ready)에 [E2E 큐에 추가] → 큐에 `대기` 작업 1개 추가
- AC-02 실행 중 작업이 없으면 맨 앞 대기 작업이 자동 시작(전역 FIFO, 동시 1개)
- AC-03 단계 시작 = 그 이슈의 새 터미널 패널(launchPane)에 역할 명령 입력(queueLaunch). 시작 전 `.minmo/e2e/<jobId>/.gitignore`(`*`) 생성
- AC-04 명령 = 역할의 CLI 명령 틀(agentCommands) + 모델 인자(A-4) + 지시문(자리표시 치환, 한 줄, 셸별 quoteArg)
- AC-05 단계 완료 판정. 결과 파일이 있고 비어 있지 않음(ⓐ), 파일 version 이 폴링 2회 연속 같음 — 쓰는 중 아님(ⓑ), 에이전트 상태(ⓒ)로 본다. "감지됨" = 그 패널의 에이전트 상태가 있고 종류가 역할의 CLI 이거나 `other`:
  - 감지됨: `idle` → 완료. `working`·`attention` → 기다림(attention 이면 작업 상태에 "확인 필요 — 패널을 보세요")
  - 이 단계에서 감지된 적이 있는데 폴링 3회 연속 없음(터미널은 그대로 있음) = 에이전트 종료 → **자동 완료하지 않음**. 작업 상태 "에이전트가 종료됨 — 결과를 보고 [다음 단계]로 넘기세요"(사용자 Ctrl+C 로 미완성 결과가 넘어가지 않게)
  - 한 번도 감지 안 됨(원격 tmux 없음 + codex 등 제목 신호 없음): ⓐ + version 이 20초 이상 그대로면 완료. 작업 상태 "상태 감지 불가 — 결과 파일 기준"
  - 터미널이 잠깐 내려감(터미널 id 없음) 동안은 판정하지 않고 기다림
  - 기본 지시문(A-7)에 "모든 작업·질문이 끝난 뒤 마지막에 결과 파일을 한 번에 쓴다. 사용자에게 물을 것이 있으면 파일을 쓰지 말고 묻는다"를 넣어 idle 오판을 줄임
  - 완료되면 다음 단계 시작. ③ 완료 → 작업 `완료`, 다음 작업 시작
- AC-06 [다음 단계]: 실행 중 작업의 현재 단계를 사용자가 완료 처리(③이면 작업 완료)
- AC-07 [취소]: 실행/대기 작업 취소(패널은 남김). 실행 중이면 다음 작업 시작
- AC-08 [다시 실행]: 실패·취소·완료 작업을 새 대기 작업으로 다시 추가. [목록에서 지우기]: 끝난 작업 제거
- AC-09 [패널로 이동]: 단계 패널로 이동
- AC-10 역할 설정: 역할마다 CLI(claude/codex/gemini), 모델(목록 + 직접 입력 + 기본값), 지시문. 저장 = ui store persist + 공유 동기화
- AC-11 모델 목록: CLI를 고르면 그 호스트(로컬/원격)에서 목록 조회. [새로 고침] 제공. 로딩·오류 표시
- AC-12 큐 상태 표시: 작업마다 이슈 이름, 상태(대기 / 실행 중 n/3 단계명 / 완료 / 실패 사유 / 취소)

## 엣지 케이스 (EC)
- EC-01 시작 때 작업 폴더가 ready 아님 → 실패 "작업 폴더가 열려 있지 않습니다", 다음 작업 진행
- EC-02 실행 중 단계 패널이 닫힘 → 실패 "터미널 패널이 닫혔습니다"
- EC-03 결과 파일은 생겼지만 에이전트가 아직 working → 기다림
- EC-04 같은 이슈 중복 추가(대기/실행 중) → 추가하지 않고 안내(A-9)
- EC-05 모델 값에 공백·따옴표·`;`·`-` 시작 등 → 입력 거부(A-6 패턴 하나만 사용), 저장 불가 안내
- EC-06 모델 목록 조회 실패(CLI 없음·파싱 실패) → 오류 문구 + 직접 입력 가능
- EC-07 명령 틀이 비었거나 `{prompt}` 가 따옴표 안 → 명령 만들기 오류를 작업 실패 사유로
- EC-08 원격 호스트 이슈 → POSIX 셸 따옴표, 모델 목록·파일 확인은 ssh 로
- EC-09 `.gitignore` 생성 실패 → 작업 실패(사유 표시)
- EC-10 결과 파일: 없음 → 계속 폴링 / 너무 큼(2MB 초과)·텍스트가 아님 → 있는 것으로 봄(ⓑ는 크기 대신 연속 확인 2회) / 그 밖의 읽기 오류 5회 연속 → 실패 "결과 파일을 확인하지 못했습니다: …"
- EC-11 공유 동기화·로컬 복원으로 받은 역할 설정이 잘못된 형태 → 역할별로 알려진 유효 값만 받고 나머지 기본값(모델 패턴 검사 포함)
- EC-12 명령을 맡긴 뒤 110초가 지나도 아직 입력 대기(터미널이 안 뜨거나 첫 출력이 없음) → 실패(A-10). 대기열 TTL(120초)보다 짧게 잡아 명령이 버려진 채 멈추지 않게 함
- EC-12b 명령은 꺼냈지만 60초 동안 에이전트 감지도 결과 파일도 없음 → 실패시키지 않고 상태 "에이전트 상태를 확인할 수 없음 — 패널을 보세요(ssh 인증 등)". 단계 시간 제한은 범위 밖이므로 자동 실패하지 않고, "확인 필요" 상태(이 문구·attention·"에이전트가 종료됨")면 상단 [E2E 큐] 버튼에 강조 표시(EC-23)
- EC-13 [다음 단계]와 자동 완료 판정이 겹침 → 한 번만 넘어감(현재 단계가 다르면 무시, 폴링은 동시에 하나만)
- EC-14 원격 호스트 작업인데 연결 정보 없음: 시작 시 → 실패 "원격 호스트에 연결되지 않았습니다" / 실행 중 → 그 회차 확인 건너뜀(상태 "연결 대기")
- EC-15 원격 호스트 이슈는 첫 패널(기존 tmux 세션)을 쓰지 않음
- EC-16 패널이 뜨기 전 [취소] → 대기 명령 삭제로 나중에 터미널이 떠도 실행되지 않음
- EC-17 원격 ssh 의 PATH 에 CLI 가 없음 → profile 을 읽고 실행, 그래도 실패면 "원격 PATH 에서 <cli> 를 찾지 못했습니다" + 직접 입력
- EC-18 단계 패널의 터미널이 처음 관측한 것과 다른 값이 됨(작업 폴더 삭제 후 재생성으로 같은 패널 id 재사용 등) → EC-02 와 같이 실패. 값 없음(터미널 잠깐 내려감)은 기다림
- EC-19 작업 폴더 삭제·이슈 키 변경으로 그 이슈의 패널 구성이 사라짐 → EC-02 로 실패
- EC-20 큐는 화면마다 따로 있음(원격 접속 화면 포함, A-2). 다른 화면에서 패널을 닫으면 이 화면 작업은 EC-02 로 실패
- EC-21 비동기 시작·단계 전환 중 [취소]/[다음 단계] → 각 대기 뒤 작업이 실행 중이고 단계가 같은지 다시 확인, 아니면 패널·명령을 만들지 않음
- EC-22 패널이 명령을 꺼내 들고 있는 동안(ssh 인증 프롬프트 대기 등) [취소] → 대기열 항목이 지워져 터미널이 입력하지 않음. 같은 패널에 새 명령을 넣으면 새 명령만 입력됨
- EC-23 실행 중 작업이 "확인 필요" 상태 → 작업의 `notice`(`attention`·`exited`·`undetected`·`unknown`)를 매 폴링 다시 계산해 설정·해제(늦게 감지되거나 attention 이 풀리면 사라짐). 상단 버튼 이름·배지에 표시("E2E 큐 — 확인 필요", `undetected` 는 결과 파일로 진행하므로 제외), 작업 행에 해당 문구
- EC-24 [다시 실행]은 항상 새 jobId(새 결과 폴더) — 옛 결과 파일로 ①이 바로 완료되지 않게

권한·소유권: 해당 없음 — 단일 사용자 데스크탑 앱이다. 원격 기기는 이미 터미널을 조작할 수 있고, 모델 목록 조회는 읽기 전용 명령이라 같은 범위로 허용한다(A-13).

## 알려진 제한
- Codex 는 제목 신호가 없어 "에이전트가 쉬는 중"을 출력이 4초 조용함으로 추정한다 → 결과 파일 + version 안정 조건을 함께 써서 완화한다(D-6, AC-05).
- 모델 목록 명령·Claude 캐시 형식이 CLI 버전마다 바뀔 수 있다 → 파서가 실패하면 직접 입력한다(EC-06).
- 원격 폴링은 3초마다 ssh 1회(파일 확인), 파일이 있을 때만 읽는다.
- 취소한 작업의 에이전트가 계속 돌면 다음 작업과 동시에 돌 수 있다(A-11, 사용자 판단).
- 2MB 초과·텍스트가 아닌 결과 파일은 version 이 없어 "쓰는 중 아님" 보장이 약하다(EC-10).
- 큐 패널은 사용자가 보지 않으므로 늦은 벨이 attention 으로 남으면 그 패널을 볼 때까지 기다린다(상태 문구로 안내).

## 미결
- 없음. 단, [Assumption] 항목(A-1~A-15)은 사용자 확인 전이다.
