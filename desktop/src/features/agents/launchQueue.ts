// 에이전트 실행 대기열 — 새로 만든 터미널 패널이 준비되면(셸의 첫 출력이 나오면) 넣을 명령.
// 화면 상태가 아니라 한 번 쓰고 버리는 값이라 store 에 두지 않는다.
// taken: 터미널이 꺼내 들고 셸 준비를 기다리는 중 — 입력 직전(consumeLaunch)까지 남겨 두어 그 사이의 취소·덮어쓰기를 알 수 있게 한다(#92 EC-22)
const queued = new Map<string, { command: string; at: number; taken: boolean }>()

/** 맡긴 뒤 이만큼 지나도록 터미널이 뜨지 않았으면 버린다 — 한참 뒤에 같은 패널 id 가 다시 쓰일 때 옛 명령이 실행되지 않게 */
export const LAUNCH_TTL_MS = 120_000

/** paneId 의 터미널이 준비되면 command 를 실행하게 맡긴다(꺼내 둔 옛 명령은 덮인다) */
export function queueLaunch(paneId: string, command: string) {
  queued.set(paneId, { command, at: Date.now(), taken: false })
}

/** paneId 에 맡겨 둔 명령을 꺼낸다(한 번만 돌려준다). 실제로 넣기 직전에 consumeLaunch 로 확인한다 */
export function takeLaunch(paneId: string): string | undefined {
  const q = queued.get(paneId)
  if (q === undefined || q.taken) return undefined
  if (Date.now() - q.at > LAUNCH_TTL_MS) {
    queued.delete(paneId)
    return undefined
  }
  q.taken = true
  return q.command
}

/** 꺼낸 명령을 실제로 입력하기 직전에 확인한다 — 꺼낸 뒤 취소됐거나 새 명령으로 덮였으면 false */
export function consumeLaunch(paneId: string): boolean {
  const q = queued.get(paneId)
  if (q === undefined || !q.taken) return false
  queued.delete(paneId)
  return true
}

/** 맡긴 명령을 지운다(꺼낸 것 포함) */
export function cancelLaunch(paneId: string): void {
  queued.delete(paneId)
}

/** 맡긴 명령이 아직 꺼내지지 않고 TTL 안에 있는가 */
export function isLaunchPending(paneId: string): boolean {
  const q = queued.get(paneId)
  return q !== undefined && !q.taken && Date.now() - q.at <= LAUNCH_TTL_MS
}

/**
 * 터미널의 마지막 줄이 ssh 의 비밀번호·호스트 키 확인을 묻는 중인가 — 그때 명령을 넣으면 그 물음의 답으로 들어간다.
 * 셸이 뜰 때까지 기다린다.
 */
export function looksLikeAuthPrompt(line: string): boolean {
  return /password|passphrase|verification code|yes\/no|비밀번호|암호/i.test(line)
}

/** 출력이 이만큼 잠잠해진 뒤에 넣는다 — 너무 일찍 넣으면 셸의 시작 출력과 섞여 보인다 */
export const LAUNCH_DELAY_MS = 300
