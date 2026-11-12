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
import type { LocalTask } from '../../store/repos'
import { useUiStore } from '../../store/ui'
import { forgetIssues, orgNodeId, repoNodeId } from './localRepos'

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
const githubUrl = (owner: string, name: string) => `https://github.com/${owner}/${name}.git`
const sameTasks = (a: LocalTask[], b: LocalTask[]) => a.length === b.length && a.every((t, i) => t.number === b[i].number && t.title === b[i].title && t.state === b[i].state)

/** 올리는 중인 저장소 id — 같은 저장소를 동시에 두 번 올리면 이슈가 겹쳐 만들어진다 */
const inflight = new Set<string>()
export const isPublishing = (id: string) => inflight.has(id)

/** 올린 뒤의 GitHub 저장소(owner·name)를 돌려준다. 실패하면 PublishError(어느 단계인지 포함) */
export async function publishRepo(deps: PublishDeps, host: Host, input: PublishInput, onStep?: (step: PublishStep) => void): Promise<{ owner: string; name: string }> {
  if (inflight.has(input.id)) throw new PublishError('create', '이미 올리는 중입니다')
  inflight.add(input.id)
  let step: PublishStep = 'create'
  const at = (s: PublishStep) => {
    step = s
    onStep?.(s)
  }
  /** 도중에 목록에서 제거됐으면 멈춘다 */
  const current = () => {
    const repo = useReposStore.getState().local[input.id]
    if (!repo) throw new Error('올리는 도중 저장소가 목록에서 제거됐습니다')
    return repo
  }
  try {
    const local = current()
    // git 은 이 영역의 호스트에서 실행된다 — 저장소가 있는 호스트여야 한다
    if (local.hostId !== host.id) throw new Error(`이 저장소는 다른 호스트(${local.hostId})에 있습니다 — 그 호스트를 고른 뒤 다시 하세요`)
    const { path } = local

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
      current()
      useReposStore.getState().setPublish(input.id, target)
    }
    const { owner, name } = target

    // 2. origin
    at('remote')
    if (await lacksOrigin(deps.tauri.gitRun, path)) {
      const add = await deps.tauri.gitRun(['-C', path, 'remote', 'add', 'origin', githubUrl(owner, name)])
      if (add.code !== 0) throw new Error(add.stderr.trim() || 'git remote add 실패')
    }

    // 3. 모든 로컬 브랜치(작업 브랜치 포함). GitHub 는 처음 받은 브랜치를 기본 브랜치로 삼으므로 저장소의 현재 브랜치를 먼저 보낸다
    at('push')
    const head = await deps.tauri.gitRun(['-C', path, 'symbolic-ref', '--short', 'HEAD'])
    const trunk = head.code === 0 ? head.stdout.trim() : ''
    for (const refs of trunk ? [[trunk], ['--all']] : [['--all']]) {
      const push = await deps.tauri.gitRun(['-C', path, 'push', '-u', 'origin', ...refs])
      if (push.code !== 0) throw new Error(push.stderr.trim() || 'git push 실패')
    }

    // 4. 작업 → 이슈. 새 저장소의 이슈 번호는 1부터 차례로 매겨지므로 작업 번호 순서대로 만들면 번호가 같다
    at('issues')
    const tasks = [...current().tasks].sort((a, b) => a.number - b.number)
    const existing = await deps.github.listIssues(owner, name)
    // 이미 있는 이슈는 이전 시도에서 만든 것(작업 1..k, 제목 같음)이어야 한다. 아니면 번호가 어긋난 것이므로
    // 이슈를 더 만들지 않고 멈춘다 — 잘못된 이슈에 작업 폴더·메모를 붙이지 않게
    for (const issue of existing) {
      const task = tasks[issue.number - 1]
      if (!task || task.title !== issue.title || existing.length < issue.number) {
        throw new Error(`GitHub 저장소에 작업과 맞지 않는 이슈 #${issue.number} 가 있습니다 — 번호를 맞출 수 없어 멈춥니다. [처음부터 다시] 로 다른 저장소에 올리세요`)
      }
    }
    const byNumber = new Map(existing.map((i) => [i.number, i]))
    for (const task of tasks) {
      let issue = byNumber.get(task.number)
      if (!issue) {
        issue = await deps.github.createIssue(owner, name, task.title)
        if (issue.number !== task.number) {
          throw new Error(`작업 #${task.number} 이 이슈 #${issue.number} 로 만들어졌습니다 — 번호가 달라 멈춥니다. [처음부터 다시] 로 다른 저장소에 올리세요`)
        }
      }
      if (task.state === 'closed' && issue.state === 'open') await deps.github.closeIssue(owner, name, task.number)
    }

    // 5. 서버의 메모·프로젝트 설정 복사(원본은 그대로 둔다)
    at('copy')
    const keys = ['etc', ...tasks.map((t) => String(t.number))]
    for (const key of keys) {
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
    // 그 사이 작업을 더하거나 닫았으면 이슈와 어긋난다 → 전환하지 않고 다시 실행하게 한다(이어서 하면 그 차이만 반영된다)
    if (!sameTasks(tasks, [...current().tasks].sort((a, b) => a.number - b.number))) {
      throw new Error('올리는 동안 작업이 바뀌었습니다 — [이어서 올리기] 로 바뀐 작업을 반영하세요')
    }
    const issues: Record<string, string> = {}
    for (const key of keys) issues[host.issueId(LOCAL_OWNER, input.id, key)] = host.issueId(owner, name, key)
    // 옛 id 로 열려 있던 터미널·편집 내용·열기 상태는 정리한다(새 id 로 다시 연다)
    forgetIssues(Object.keys(issues), deps.tauri.ptyKill)
    const ui = useUiStore.getState()
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
  } finally {
    inflight.delete(input.id)
  }
}

/**
 * 멈춘 올리기를 처음부터 다시 하게 한다 — 진행 기록을 지우고, 이 앱이 붙인 origin(그 GitHub 저장소 주소일 때만)을 뗀다.
 * GitHub 에 만들어진 저장소는 지우지 않는다(사용자가 GitHub 에서 직접 지운다).
 */
export async function resetPublish(tauri: Pick<TauriApi, 'gitRun'>, id: string): Promise<void> {
  if (inflight.has(id)) throw new Error('올리는 중에는 다시 시작할 수 없습니다')
  const local = useReposStore.getState().local[id]
  if (!local?.publish) return
  const origin = await tauri.gitRun(['-C', local.path, 'remote', 'get-url', 'origin'])
  if (origin.code === 0 && origin.stdout.trim() === githubUrl(local.publish.owner, local.publish.name)) {
    const rm = await tauri.gitRun(['-C', local.path, 'remote', 'remove', 'origin'])
    if (rm.code !== 0) throw new Error(rm.stderr.trim() || 'git remote remove 실패')
  }
  useReposStore.getState().setPublish(id, null)
}

/** GitHub 저장소 이름으로 쓸 수 있게 폴더명을 다듬는다 */
export const githubNameOf = (displayName: string) => displayName.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'
