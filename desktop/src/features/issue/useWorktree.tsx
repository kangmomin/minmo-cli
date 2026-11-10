// worktree 서비스 배선(앱 수명 1개) + 이슈 열기/취소/재실행/삭제 액션
import { useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'

import { ApiError } from '@minmo/api-client'

import { useDeps } from '../../app/deps'
import { fetchEffective } from '../../lib/effective'
import { GitHubError } from '../../lib/github'
import { WorktreeError, createWorktreeService, worktreeId } from '../../lib/worktree'
import type { DeleteResult, IssueTarget, WorktreeService } from '../../lib/worktree'
import { useSetupStore } from '../../store/setup'
import { uiWorktreePathStore, useUiStore } from '../../store/ui'

const WorktreeContext = createContext<WorktreeService | null>(null)

export function WorktreeProvider({ children }: { children: ReactNode }) {
  const deps = useDeps()
  const queryClient = useQueryClient()
  const service = useMemo(
    () =>
      createWorktreeService({
        tauri: deps.tauri,
        getEffective: (o, r) => fetchEffective(queryClient, deps.api, o, r),
        defaultBranch: (o, r) => deps.github.defaultBranch(o, r),
        pathStore: uiWorktreePathStore(),
        home: deps.home,
        platform: deps.platform,
        onLog: (e) => {
          const st = useSetupStore.getState()
          st.appendLog(e)
          if (e.step === 'script' && e.status === 'start') st.setScript(e.issueId, { status: 'running' })
          // worktree 가 만들어지면 스크립트 완료를 기다리지 않고 이슈를 연다(터미널·메모 사용 가능)
          if (e.step === 'worktree' && e.status === 'ok') {
            const entry = useUiStore.getState().worktreePathMap[e.issueId]
            if (entry) st.setOpen(e.issueId, { phase: 'ready', path: entry.path, branch: entry.branch, pathChanged: false })
          }
        },
      }),
    [deps, queryClient],
  )
  return <WorktreeContext.Provider value={service}>{children}</WorktreeContext.Provider>
}

function useWorktreeService(): WorktreeService {
  const s = useContext(WorktreeContext)
  if (!s) throw new Error('WorktreeProvider 가 없습니다')
  return s
}

/** 사용자에게 보여 줄 오류 문구 (UI State: git·스크립트 오류는 stderr 전문) */
export function describeOpenError(e: unknown): { code: string; message: string; path?: string } {
  if (e instanceof WorktreeError) {
    switch (e.code) {
      case 'path_exists_unregistered':
        return {
          code: e.code,
          path: e.path,
          message: `경로가 이미 있지만 git worktree 가 아닙니다 — 설정에서 다른 경로를 쓰거나 폴더를 정리한 뒤 다시 여세요: ${e.path}`,
        }
      case 'overlaps_main_clone':
        return { code: e.code, path: e.path, message: `${e.message} — 설정의 worktree 경로를 바꾸세요` }
      case 'branch_conflicts_etc':
        return { code: e.code, message: '브랜치명이 기타 브랜치와 충돌 — 브랜치 템플릿을 바꾸세요' }
      case 'server_required':
        return { code: e.code, message: '서버 연결 필요 — 설정(effective)을 받아 온 적이 없어 이슈를 열 수 없습니다' }
      case 'git_failed':
        return { code: e.code, message: e.stderr?.trim() || e.message }
      default:
        return { code: e.code, message: e.message }
    }
  }
  if (e instanceof ApiError) return { code: e.code, message: `서버 오류(${e.code})` }
  if (e instanceof GitHubError) return { code: e.code, message: `GitHub 오류(${e.code}) ${e.message}` }
  return { code: 'unknown', message: e instanceof Error ? e.message : String(e) }
}

export function useIssueActions() {
  const service = useWorktreeService()

  return useMemo(
    () => ({
      /** 이슈 선택 + worktree 준비(AC-05~07). 이미 있으면 전환(AC-06) */
      async open(t: IssueTarget) {
        const id = worktreeId(t.owner, t.repo, t.key)
        const st = useSetupStore.getState()
        st.setTarget(id, t)
        useUiStore.getState().selectIssue(id)
        const prev = st.open[id]
        if (prev?.phase === 'opening') return
        if (prev?.phase === 'ready') {
          // 전환(AC-06): 터미널 세션을 유지하도록 상태를 바꾸지 않고, 배경에서 경로 변경 여부만 갱신
          if (st.script[id]?.status === 'running') return
          service
            .openIssue(t)
            .then((res) =>
              useSetupStore.getState().setOpen(id, { phase: 'ready', path: res.path, branch: res.branch, pathChanged: res.pathChanged }),
            )
            .catch(() => undefined)
          return
        }
        st.clearLog(id)
        st.setOpen(id, { phase: 'opening' })
        try {
          const res = await service.openIssue(t)
          useSetupStore.getState().setOpen(id, { phase: 'ready', path: res.path, branch: res.branch, pathChanged: res.pathChanged })
          if (res.script.status !== 'skipped') useSetupStore.getState().setScript(id, res.script)
        } catch (e) {
          useSetupStore.getState().setOpen(id, { phase: 'error', ...describeOpenError(e) })
        }
      },
      async cancelSetup(t: IssueTarget) {
        try {
          await service.cancelSetup(t)
        } catch (e) {
          const id = worktreeId(t.owner, t.repo, t.key)
          useSetupStore.getState().appendLog({ issueId: id, step: 'script', status: 'error', message: describeOpenError(e).message })
        }
      },
      async rerunScript(t: IssueTarget) {
        const id = worktreeId(t.owner, t.repo, t.key)
        const st = useSetupStore.getState()
        st.setScript(id, { status: 'running' })
        try {
          st.setScript(id, await service.rerunScript(t))
        } catch (e) {
          // 실행 전 실패(worktree 없음·설정 조회 실패 등)로 'running' 에 멈추지 않도록 실패로 표시
          st.appendLog({ issueId: id, step: 'script', status: 'error', message: describeOpenError(e).message })
          st.setScript(id, { status: 'failed', exitCode: null })
        }
      },
      inspect: (t: IssueTarget) => service.inspect(t),
      localFilesDir: (t: IssueTarget) => service.localFilesDirFor(t),
      async remove(t: IssueTarget, confirmed = false): Promise<DeleteResult> {
        const res = await service.deleteWorktree(t, { confirmed })
        if (res.status === 'deleted') {
          const id = worktreeId(t.owner, t.repo, t.key)
          useSetupStore.setState((s) => {
            const open = { ...s.open }
            delete open[id]
            const script = { ...s.script }
            delete script[id]
            return { open, script }
          })
        }
        return res
      },
    }),
    [service],
  )
}
