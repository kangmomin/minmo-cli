// E2E 큐 — 이슈 단위 작업 목록(메모리, 앱을 다시 켜면 사라진다 A-2)
// TODO(Phase 5.2): 구현. 지금은 테스트가 import 할 수 있게 시그니처만 둔 스텁이다
import { create } from 'zustand'

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
/** 0 = ① E2E 실행, 1 = ② 엣지케이스 찾기, 2 = ③ 엣지케이스 기반 테스트 */
export type JobStage = 0 | 1 | 2
/** 실행 중 "확인 필요" 상태(EC-23) */
export type JobNotice = 'attention' | 'exited' | 'undetected' | 'unknown'

export type E2eJob = {
  id: string
  issueId: string
  title: string
  status: JobStatus
  stage: JobStage
  /** 단계별 터미널 패널 id(아직 없으면 null) */
  panes: [string | null, string | null, string | null]
  startedAt?: number
  notice?: JobNotice
  /** 원격 호스트 연결을 기다리는 중(EC-14) */
  waitingHost?: boolean
  error?: string
}

export interface E2eQueueState {
  jobs: E2eJob[]
  /** 같은 이슈가 대기/실행 중이면 추가하지 않고 false(EC-04) */
  enqueue(issueId: string, title: string): boolean
  start(id: string): void
  setStagePane(id: string, stage: JobStage, paneId: string): void
  /** 현재 단계가 expectedStage 일 때만 다음 단계로(③이면 완료) — EC-13 */
  advance(id: string, expectedStage: JobStage): void
  fail(id: string, error: string): void
  cancel(id: string): void
  /** 끝난 작업을 새 jobId 의 대기 작업으로 다시 추가한다(EC-24) */
  retry(id: string): void
  remove(id: string): void
  setNotice(id: string, stage: JobStage, notice: JobNotice | undefined): void
}

const notImplemented = () => {
  throw new Error('not implemented')
}

export const useE2eQueueStore = create<E2eQueueState>()(() => ({
  jobs: [],
  enqueue: notImplemented,
  start: notImplemented,
  setStagePane: notImplemented,
  advance: notImplemented,
  fail: notImplemented,
  cancel: notImplemented,
  retry: notImplemented,
  remove: notImplemented,
  setNotice: notImplemented,
}))
