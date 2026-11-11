// worktree 서비스 배선(앱 수명 1개) + 이슈 열기/취소/재실행/삭제 액션
import { useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'

import { ApiError, normalizePath } from '@minmo/api-client'
import type { Platform } from '@minmo/api-client'

import { useHost, useHostDeps } from '../../app/host'
import type { Host } from '../../app/host'
import { fetchEffective } from '../../lib/effective'
import { GitHubError } from '@minmo/core'
import { WorktreeError, createWorktreeService } from '@minmo/core'
import type { DeleteResult, IssueTarget, WorktreeService } from '@minmo/core'
import { baseRepoOf, useHostsStore } from '../../store/hosts'
import { isLocalOwner } from '../../store/repos'
import { useSetupStore } from '../../store/setup'
import { fileDrafts } from '../files/fileDrafts'
import { uiWorktreePathStore, useUiStore } from '../../store/ui'

const trimSep = (p: string) => p.replace(/[\\/]+$/, '')

/** main 이 이 호스트에 등록된 기준 저장소 폴더인가 — git 이 돌려준 경로(구분자·대소문자가 다를 수 있다)와도 맞게 비교한다 */
function isBaseRepo(hostId: string, main: string, platform: Platform): boolean {
  const want = normalizePath(main, platform)
  return Object.values(useHostsStore.getState().baseRepos[hostId] ?? {}).some((p) => normalizePath(p, platform) === want)
}

type ServiceFor = (host: Host) => WorktreeService

const WorktreeContext = createContext<ServiceFor | null>(null)

/** 호스트마다 worktree 서비스를 하나씩 둔다(실행 중인 스크립트·잠금이 호스트를 전환해도 유지되게) */
export function WorktreeProvider({ children }: { children: ReactNode }) {
  const hostDeps = useHostDeps()
  const queryClient = useQueryClient()
  const services = useRef(new Map<string, { deps: unknown; service: WorktreeService }>())
  const serviceFor = useMemo<ServiceFor>(
    () => (host) => {
      const deps = hostDeps(host)
      const hit = services.current.get(host.id)
      if (hit && hit.deps === deps) return hit.service
      const paths = uiWorktreePathStore()
      const service = createWorktreeService({
        tauri: deps.tauri,
        // 기준 저장소(가져온 기존 폴더)가 있으면 설정의 메인 clone 대신 그 저장소에서 worktree 를 만든다
        getEffective: async (o, r) => {
          const eff = await fetchEffective(queryClient, deps.api, o, r)
          const base = baseRepoOf(useHostsStore.getState(), host.id, o, r)
          if (!base) return eff
          // 폴더가 없어졌으면 그 자리에 새로 clone 하지 않고 알린다(사용자 폴더 자리에 빈 저장소를 만들지 않게)
          if (!(await deps.tauri.pathExists(base))) throw new Error(`기준 저장소 폴더가 없습니다: ${base} — 저장소의 [기준 저장소 폴더] 에서 다시 지정하거나 해제하세요`)
          return { ...eff, values: { ...eff.values, mainClonePath: base } }
        },
        // 기존 저장소의 옆 폴더는 다른 저장소와 겹칠 수 있어, 보관 폴더를 그 저장소의 .git 안에 둔다
        localDirFor: (main) => (isBaseRepo(host.id, main, deps.platform) ? `${trimSep(main)}${deps.platform === 'win32' ? '\\' : '/'}.git${deps.platform === 'win32' ? '\\' : '/'}minmo-local` : undefined),
        // 로컬 저장소(GitHub 아님)는 물어볼 곳이 없다 — core 가 저장소의 origin/HEAD 나 현재 브랜치로 정한다
        defaultBranch: (o, r) => (isLocalOwner(o) ? Promise.reject(new Error('GitHub 저장소가 아닙니다')) : deps.github.defaultBranch(o, r)),
        // core 는 호스트를 모른다 — 기록·로그의 id 만 이 호스트의 것으로 바꿔 준다
        pathStore: { get: (id) => paths.get(host.scope(id)), set: (id, e) => paths.set(host.scope(id), e), delete: (id) => paths.delete(host.scope(id)) },
        home: deps.home,
        platform: deps.platform,
        onLog: (raw) => {
          const e = { ...raw, issueId: host.scope(raw.issueId) }
          const st = useSetupStore.getState()
          st.appendLog(e)
          if (e.step === 'script' && e.status === 'start') st.setScript(e.issueId, { status: 'running' })
          // worktree 가 만들어지면 스크립트 완료를 기다리지 않고 이슈를 연다(터미널·메모 사용 가능)
          if (e.step === 'worktree' && e.status === 'ok') {
            const entry = useUiStore.getState().worktreePathMap[e.issueId]
            if (entry) st.setOpen(e.issueId, { phase: 'ready', path: entry.path, branch: entry.branch, pathChanged: false })
          }
        },
      })
      services.current.set(host.id, { deps, service })
      return service
    },
    [hostDeps, queryClient],
  )
  return <WorktreeContext.Provider value={serviceFor}>{children}</WorktreeContext.Provider>
}

/** 이 영역의 호스트(app/host.tsx HostScope)에서 동작하는 worktree 서비스 */
function useWorktreeService(): { service: WorktreeService; host: Host } {
  const serviceFor = useContext(WorktreeContext)
  const host = useHost()
  if (!serviceFor) throw new Error('WorktreeProvider 가 없습니다')
  return useMemo(() => ({ service: serviceFor(host), host }), [serviceFor, host])
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
  const { service, host } = useWorktreeService()
  const worktreeId = host.issueId

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
          // 지운 worktree 의 편집 내용이 다시 만든 worktree 에 나타나지 않게
          fileDrafts.clearScope(id)
        }
        return res
      },
    }),
    [service, worktreeId],
  )
}
