// 에이전트 실행 대기열 — 새로 만든 터미널 패널이 준비되면(셸의 첫 출력이 나오면) 넣을 명령.
// 화면 상태가 아니라 한 번 쓰고 버리는 값이라 store 에 두지 않는다.
const queued = new Map<string, string>()

/** paneId 의 터미널이 준비되면 command 를 실행하게 맡긴다 */
export function queueLaunch(paneId: string, command: string) {
  queued.set(paneId, command)
}

/** paneId 에 맡겨 둔 명령을 꺼낸다(한 번만 돌려준다) */
export function takeLaunch(paneId: string): string | undefined {
  const cmd = queued.get(paneId)
  queued.delete(paneId)
  return cmd
}

/** 셸이 첫 프롬프트를 그린 뒤에 넣는다 — 너무 일찍 넣으면 셸의 시작 출력과 섞여 보인다 */
export const LAUNCH_DELAY_MS = 300
