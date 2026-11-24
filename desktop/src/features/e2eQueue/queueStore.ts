// E2E 큐 — 이슈 단위 작업 목록(메모리, 앱을 다시 켜면 사라진다 A-2)
import { create } from 'zustand'

import { cancelLaunch } from '../agents/launchQueue'

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

/** 대기·실행 중(아직 끝나지 않음) */
export const isActive = (j: E2eJob) => j.status === 'queued' || j.status === 'running'

/** 결과 폴더 이름(.minmo/e2e/<jobId>)으로 쓰인다 — 경로에 안전한 글자만 */
function newJobId(jobs: readonly E2eJob[]): string {
  for (;;) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    if (!jobs.some((j) => j.id === id)) return id
  }
}

const queuedJob = (jobs: readonly E2eJob[], issueId: string, title: string): E2eJob => ({
  id: newJobId(jobs),
  issueId,
  title,
  status: 'queued',
  stage: 0,
  panes: [null, null, null],
})

/** id 의 작업만 fn 으로 바꾼다. fn 이 같은 객체를 돌려주면 목록도 그대로 둔다(다시 그리지 않게) */
function update(jobs: E2eJob[], id: string, fn: (j: E2eJob) => E2eJob): E2eJob[] {
  const i = jobs.findIndex((j) => j.id === id)
  if (i < 0) return jobs
  const next = fn(jobs[i])
  if (next === jobs[i]) return jobs
  const out = jobs.slice()
  out[i] = next
  return out
}

/** 끝난 상태로 — 실행 중 표시(확인 필요·연결 대기)는 지운다 */
const finish = (j: E2eJob, status: 'done' | 'failed' | 'cancelled', error?: string): E2eJob => {
  const { notice: _notice, waitingHost: _waitingHost, ...rest } = j
  return { ...rest, status, ...(error !== undefined && { error }) }
}

export const useE2eQueueStore = create<E2eQueueState>()((set, get) => {
  /** id 의 작업 하나를 바꾼다. 목록이 그대로면 상태도 그대로 둬 구독자에게 알리지 않는다 */
  const change = (id: string, fn: (j: E2eJob) => E2eJob) =>
    set((s) => {
      const jobs = update(s.jobs, id, fn)
      return jobs === s.jobs ? s : { jobs }
    })

  return {
    jobs: [],
    enqueue: (issueId, title) => {
      if (get().jobs.some((j) => j.issueId === issueId && isActive(j))) return false
      set((s) => ({ jobs: [...s.jobs, queuedJob(s.jobs, issueId, title)] }))
      return true
    },
    start: (id) =>
      change(id, (j) =>
        j.status === 'queued' ? { ...j, status: 'running', stage: 0, panes: [null, null, null], startedAt: Date.now() } : j,
      ),
    setStagePane: (id, stage, paneId) =>
      change(id, (j) => {
        if (j.status !== 'running' || j.stage !== stage || j.panes[stage] === paneId) return j
        const panes: E2eJob['panes'] = [...j.panes]
        panes[stage] = paneId
        return { ...j, panes }
      }),
    advance: (id, expectedStage) =>
      change(id, (j) => {
        // [다음 단계]와 자동 완료가 겹치면 뒤에 온 쪽은 단계가 이미 달라 무시된다(EC-13)
        if (j.status !== 'running' || j.stage !== expectedStage) return j
        if (j.stage === 2) return finish(j, 'done')
        const { notice: _notice, waitingHost: _waitingHost, ...rest } = j
        return { ...rest, stage: (j.stage + 1) as JobStage }
      }),
    fail: (id, error) => change(id, (j) => (isActive(j) ? finish(j, 'failed', error) : j)),
    cancel: (id) => {
      const job = get().jobs.find((j) => j.id === id)
      if (!job || !isActive(job)) return
      // 아직 입력되지 않은 명령은 지운다 — 이미 돌고 있는 에이전트는 패널에 남긴다(A-11, EC-16·EC-22)
      const pane = job.status === 'running' ? job.panes[job.stage] : null
      if (pane !== null) cancelLaunch(pane)
      change(id, (j) => finish(j, 'cancelled'))
    },
    retry: (id) => {
      const job = get().jobs.find((j) => j.id === id)
      if (!job || isActive(job)) return
      // 새 jobId = 새 결과 폴더 — 옛 결과 파일로 ①이 바로 끝나지 않게(EC-24). 같은 이슈가 이미 대기·실행 중이면 넣지 않는다(EC-04)
      get().enqueue(job.issueId, job.title)
    },
    remove: (id) => set((s) => (s.jobs.some((j) => j.id === id && !isActive(j)) ? { jobs: s.jobs.filter((j) => j.id !== id) } : s)),
    setNotice: (id, stage, notice) =>
      change(id, (j) => {
        if (j.status !== 'running' || j.stage !== stage || j.notice === notice) return j
        const { notice: _notice, ...rest } = j
        return notice === undefined ? rest : { ...rest, notice }
      }),
  }
})
