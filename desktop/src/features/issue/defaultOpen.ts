// [Red 스텁 #120] 기본 작업 공간 열기 — store 동작만(WorktreeProvider 없이 부를 수 있다). 동작은 Phase 5.2 에서 구현한다
import type { Host } from '../../app/host'

/** 기본의 열기 상태(ready = 홈, 홈을 모르면 error)를 만든다. 선택·작업 탭은 건드리지 않는다 */
export function ensureDefaultOpen(_issueId: string, _home: string | null): void {}

/** 사용자가 기본을 고를 때(행·딥링크) — 열기 상태 + 선택 + 터미널 탭 */
export function openDefault(_host: Host, _home: string | null): void {}

/** 그 호스트의 홈. 원격인데 연결 정보(probe)가 없으면 null(이 PC 의 홈으로 떨어지지 않는다) */
export function homeOf(_alias: string | null, _baseHome: string): string | null {
  return null
}
