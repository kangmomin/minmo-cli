// 직접 추가한 저장소 목록 — 이 PC 의 앱에만 저장한다(서버·GitHub 는 이 목록을 모른다).
//  - added: GitHub 목록(내 계정·내 조직 소유)에 없지만 열어 둔 GitHub 저장소
//  - local: GitHub 저장소가 아닌 폴더(새 프로젝트, origin 이 없거나 GitHub 가 아닌 저장소). 이슈 대신 앱 안의 "작업"을 쓴다
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * 로컬 저장소의 가짜 소유자. GitHub 로그인은 `_` 로 시작할 수 없어 실제 소유자와 겹치지 않고, 서버의 이름 규칙은 통과한다 —
 * 그래서 설정·메모·worktree id·경로 템플릿이 GitHub 저장소와 같은 방식으로 동작한다.
 */
export const LOCAL_OWNER = '_local'
export const isLocalOwner = (owner: string) => owner === LOCAL_OWNER

export type LocalTask = { number: number; title: string; state: 'open' | 'closed' }

/** "GitHub 에 올리기" 진행 기록 — 중간에 실패해도 같은 저장소로 이어서 진행한다 */
export type PublishProgress = { owner: string; name: string; private: boolean }

export type LocalRepo = {
  /** 폴더가 있는 호스트('local' 또는 'ssh:<별칭>') */
  hostId: string
  path: string
  /** 화면에 보이는 이름(폴더명) */
  displayName: string
  /** 번호는 1부터 이어지고 지우지 않는다(닫기만) — GitHub 에 올릴 때 이슈 번호와 맞추기 위해 */
  tasks: LocalTask[]
  publish?: PublishProgress
}

export interface ReposState {
  /** GitHub 표기 그대로의 "owner/name" */
  added: string[]
  /** 저장소 id(= 가짜 소유자 아래의 저장소 이름) → 정보 */
  local: Record<string, LocalRepo>
  /** 새 프로젝트를 마지막으로 만든 상위 폴더(호스트별) */
  lastParent: Record<string, string>

  addGitHub(owner: string, name: string): void
  removeGitHub(owner: string, name: string): void
  addLocal(repo: Pick<LocalRepo, 'hostId' | 'path' | 'displayName'>): string
  removeLocal(id: string): void
  addTask(id: string, title: string): number | null
  setTaskState(id: string, number: number, state: LocalTask['state']): void
  setPublish(id: string, publish: PublishProgress | null): void
  setLastParent(hostId: string, path: string): void
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * 폴더명 → 저장소 id. 서버 이름 규칙(영문·숫자·`_.-`, 소문자)에 맞추고, 임의 꼬리를 붙여
 * 같은 이름의 폴더를 다른 PC 에서 열거나 지웠다 다시 열어도 서버의 메모·설정이 섞이지 않게 한다.
 */
export function newLocalId(displayName: string, random: () => number = Math.random): string {
  const base =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 40) || 'repo'
  const tail = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, '0')
  return `${base}-${tail}`
}

export const useReposStore = create<ReposState>()(
  persist(
    (set, get) => ({
      added: [],
      local: {},
      lastParent: {},
      addGitHub: (owner, name) =>
        set((s) => {
          const full = `${owner}/${name}`
          return s.added.some((a) => same(a, full)) ? s : { added: [...s.added, full] }
        }),
      removeGitHub: (owner, name) => set((s) => ({ added: s.added.filter((a) => !same(a, `${owner}/${name}`)) })),
      addLocal: (repo) => {
        let id = newLocalId(repo.displayName)
        while (get().local[id]) id = newLocalId(repo.displayName)
        set((s) => ({ local: { ...s.local, [id]: { ...repo, tasks: [] } } }))
        return id
      },
      removeLocal: (id) =>
        set((s) => {
          const local = { ...s.local }
          delete local[id]
          return { local }
        }),
      addTask: (id, title) => {
        const repo = get().local[id]
        if (!repo) return null
        const number = repo.tasks.length + 1
        set((s) => ({ local: { ...s.local, [id]: { ...repo, tasks: [...repo.tasks, { number, title, state: 'open' }] } } }))
        return number
      },
      setTaskState: (id, number, state) =>
        set((s) => {
          const repo = s.local[id]
          if (!repo) return s
          return { local: { ...s.local, [id]: { ...repo, tasks: repo.tasks.map((t) => (t.number === number ? { ...t, state } : t)) } } }
        }),
      setPublish: (id, publish) =>
        set((s) => {
          const repo = s.local[id]
          if (!repo) return s
          const next = { ...repo }
          if (publish === null) delete next.publish
          else next.publish = publish
          return { local: { ...s.local, [id]: next } }
        }),
      setLastParent: (hostId, path) => set((s) => ({ lastParent: { ...s.lastParent, [hostId]: path } })),
    }),
    { name: 'minmo-repos', storage: createJSONStorage(() => localStorage) },
  ),
)

/** "owner/name" → [owner, name] */
export function splitFullName(full: string): [string, string] {
  const i = full.indexOf('/')
  return [full.slice(0, i), full.slice(i + 1)]
}

/** 화면에 보일 저장소 이름 — 로컬 저장소는 폴더명, GitHub 저장소는 owner/name */
export function repoLabelOf(s: Pick<ReposState, 'local'>, owner: string, repo: string): string {
  return isLocalOwner(owner) ? (s.local[repo]?.displayName ?? repo) : `${owner}/${repo}`
}

export function useRepoLabel(owner: string, repo: string): string {
  return useReposStore((s) => repoLabelOf(s, owner, repo))
}
