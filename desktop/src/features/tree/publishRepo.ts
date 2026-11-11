// "GitHub 에 올리기" — origin 이 없는 로컬 저장소를 새 GitHub 저장소로 만들어 push 하고, 트리 항목을 GitHub 저장소로 바꾼다.
// 각 단계는 다시 실행해도 되게(이미 한 일은 건너뛰게) 만들어, 중간에 실패하면 같은 버튼으로 이어서 진행한다.
// 마지막 전환 전까지는 로컬 저장소로 계속 쓸 수 있다.
import type { ApiClient } from '@minmo/api-client'
import { GitHubError, lacksOrigin } from '@minmo/core'
import type { GitHubClient } from '@minmo/core'

import type { Host } from '../../app/host'
import type { TauriApi } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { LOCAL_OWNER, useReposStore } from '../../store/repos'
import { useSetupStore } from '../../store/setup'
import { useUiStore } from '../../store/ui'
import { fileDrafts } from '../files/fileDrafts'
import { orgNodeId, repoNodeId } from './localRepos'

export type PublishStep = 'create' | 'remote' | 'push' | 'issues' | 'copy' | 'switch'
export const PUBLISH_STEPS: readonly PublishStep[] = ['create', 'remote', 'push', 'issues', 'copy', 'switch']
export const PUBLISH_STEP_LABEL: Record<PublishStep, string> = {
  create: 'GitHub 저장소 만들기',
  remote: 'origin 연결',
  push: '브랜치 push',
  issues: '작업을 이슈로 만들기',
  copy: '메모·프로젝트 설정 옮기기',
  switch: '트리 항목 전환',
}

export class PublishError extends Error {
  step: PublishStep
  constructor(step: PublishStep, message: string) {
    super(message)
    this.name = 'PublishError'
    this.step = step
  }
}

export interface PublishDeps {
  tauri: Pick<TauriApi, 'gitRun' | 'ptyKill'>
  github: Pick<GitHubClient, 'getRepo' | 'createRepo' | 'listIssues' | 'createIssue' | 'closeIssue'>
  api: Pick<ApiClient, 'getNotes' | 'putNotes' | 'getSettings' | 'putSettings'>
}

export type PublishInput = {
  /** 로컬 저장소 id */
  id: string
  /** 소유자 login 과, 조직이면 true */
  owner: string
  isOrg: boolean
  name: string
  private: boolean
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 올린 뒤의 GitHub 저장소(owner·name)를 돌려준다. 실패하면 PublishError(어느 단계인지 포함) */
export async function publishRepo(deps: PublishDeps, host: Host, input: PublishInput, onStep?: (step: PublishStep) => void): Promise<{ owner: string; name: string }> {
  const repos = useReposStore.getState()
  const local = repos.local[input.id]
  if (!local) throw new PublishError('create', '로컬 저장소를 찾을 수 없습니다')
  const { path } = local
  let step: PublishStep = 'create'
  const at = (s: PublishStep) => {
    step = s
    onStep?.(s)
  }
  try {
    // 1. 저장소 — 이전 시도에서 만들었으면 그 저장소로 이어 간다
    at('create')
    let target = local.publish
    if (!target) {
      if (!(await lacksOrigin(deps.tauri.gitRun, path))) throw new Error('이미 origin 원격이 있는 저장소입니다')
      const exists = await deps.github.getRepo(input.owner, input.name).then(
        () => true,
        (e) => {
          if (e instanceof GitHubError && e.code === 'not_found') return false
          throw e
        },
      )
      if (exists) throw new Error(`이미 있는 GitHub 저장소입니다: ${input.owner}/${input.name} — 다른 이름을 쓰세요`)
      const created = await deps.github.createRepo({ org: input.isOrg ? input.owner : null, name: input.name, private: input.private })
      target = { owner: created.owner, name: created.name, private: input.private }
      useReposStore.getState().setPublish(input.id, target)
    }
    const { owner, name } = target

    // 2. origin
    at('remote')
    if (await lacksOrigin(deps.tauri.gitRun, path)) {
      const add = await deps.tauri.gitRun(['-C', path, 'remote', 'add', 'origin', `https://github.com/${owner}/${name}.git`])
      if (add.code !== 0) throw new Error(add.stderr.trim() || 'git remote add 실패')
    }

    // 3. 모든 로컬 브랜치(작업 브랜치 포함)
    at('push')
    const push = await deps.tauri.gitRun(['-C', path, 'push', '-u', 'origin', '--all'])
    if (push.code !== 0) throw new Error(push.stderr.trim() || 'git push 실패')

    // 4. 작업 → 이슈. 새 저장소의 이슈 번호는 1부터 차례로 매겨지므로 작업 번호 순서대로 만들면 번호가 같다
    at('issues')
    const tasks = [...useReposStore.getState().local[input.id].tasks].sort((a, b) => a.number - b.number)
    const existing = new Map((await deps.github.listIssues(owner, name)).map((i) => [i.number, i]))
    for (const task of tasks) {
      let issue = existing.get(task.number)
      if (!issue) {
        issue = await deps.github.createIssue(owner, name, task.title)
        // 번호가 어긋나면(그 사이 다른 이슈·PR 이 생김) 작업 폴더·메모를 잘못된 이슈에 붙이게 된다 → 전환하지 않고 멈춘다
        if (issue.number !== task.number) {
          throw new Error(`작업 #${task.number} 이 이슈 #${issue.number} 로 만들어졌습니다 — 번호가 달라 전환을 멈춥니다. GitHub 에서 이슈를 확인하세요`)
        }
      }
      if (task.state === 'closed' && issue.state === 'open') await deps.github.closeIssue(owner, name, task.number)
    }

    // 5. 서버의 메모·프로젝트 설정 복사(원본은 그대로 둔다)
    at('copy')
    for (const key of ['etc', ...tasks.map((t) => String(t.number))]) {
      const from = await deps.api.getNotes(LOCAL_OWNER, input.id, key)
      if (from.body === '') continue
      const to = await deps.api.getNotes(owner, name, key)
      if (to.body !== from.body) await deps.api.putNotes(owner, name, key, { body: from.body, baseUpdatedAt: to.updatedAt })
    }
    const { updatedAt, ...settings } = await deps.api.getSettings({ kind: 'project', owner: LOCAL_OWNER, repo: input.id })
    if (updatedAt !== null && Object.values(settings).some((v) => v !== null)) {
      await deps.api.putSettings({ kind: 'project', owner, repo: name }, settings)
    }

    // 6. 전환 — 여기부터는 await 없이 한 번에(중간 상태가 남지 않게)
    at('switch')
    const ui = useUiStore.getState()
    const issues: Record<string, string> = {}
    for (const key of ['etc', ...tasks.map((t) => String(t.number))]) issues[host.issueId(LOCAL_OWNER, input.id, key)] = host.issueId(owner, name, key)
    for (const id of Object.keys(issues)) {
      // 옛 id 로 열려 있던 터미널은 닫는다(패널을 새 id 로 다시 만든다)
      for (const [pane, pty] of Object.entries(ui.terminalIds)) if (pane.startsWith(`${id}::`)) void deps.tauri.ptyKill(pty).catch(() => undefined)
      fileDrafts.clearScope(id)
    }
    useSetupStore.setState((s) => {
      const drop = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([id]) => !(id in issues)))
      return { targets: drop(s.targets), open: drop(s.open), script: drop(s.script), logs: drop(s.logs) }
    })
    ui.rekey(issues, { [repoNodeId(LOCAL_OWNER, input.id)]: repoNodeId(owner, name) })
    ui.setExpanded(orgNodeId(owner), true)
    const hosts = useHostsStore.getState()
    hosts.setBaseRepo(local.hostId, owner, name, path)
    hosts.setBaseRepo(local.hostId, LOCAL_OWNER, input.id, null)
    useReposStore.getState().addGitHub(owner, name)
    useReposStore.getState().removeLocal(input.id)
    return { owner, name }
  } catch (e) {
    if (e instanceof PublishError) throw e
    throw new PublishError(step, e instanceof GitHubError ? `GitHub 오류(${e.code}) ${e.message}` : text(e))
  }
}

/** GitHub 저장소 이름으로 쓸 수 있게 폴더명을 다듬는다 */
export const githubNameOf = (displayName: string) => displayName.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'
