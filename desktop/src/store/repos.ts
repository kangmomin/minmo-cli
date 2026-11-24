// 직접 추가한 저장소 목록 — 이 PC 의 앱에만 저장한다(서버·GitHub 는 이 목록을 모른다).
//  - added: GitHub 목록(내 계정·내 조직 소유)에 없지만 열어 둔 GitHub 저장소
//  - local: GitHub 저장소가 아닌 폴더(새 프로젝트, origin 이 없거나 GitHub 가 아닌 저장소). 이슈 대신 앱 안의 "작업"을 쓴다
//  - nicknames: 저장소 별칭(#73) — 화면에 원래 이름 대신 보이고, 경로 템플릿의 {alias} 값이 된다
//  - groups: 사용자가 이름을 붙여 묶은 저장소(#105) — 사이드바에 노드로 보이고, 그 묶음만 보이는 새 창을 열 수 있다
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { followOtherWindows, perWindowStorage } from '../lib/windowScope'

/**
 * 로컬 저장소의 가짜 소유자. GitHub 로그인은 `_` 로 시작할 수 없어 실제 소유자와 겹치지 않고, 서버의 이름 규칙은 통과한다 —
 * 그래서 설정·메모·worktree id·경로 템플릿이 GitHub 저장소와 같은 방식으로 동작한다.
 */
export const LOCAL_OWNER = '_local'
export const isLocalOwner = (owner: string) => owner === LOCAL_OWNER

/** 저장소별 값의 키(GitHub 이름은 대소문자를 가리지 않는다) */
export const repoKey = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase()

/** 별칭 최대 길이(글자 = 코드 포인트) */
export const NICKNAME_MAX = 50

/** NICKNAME_MAX 글자로 자른다(서로게이트 쌍을 자르지 않는다) */
export const clampNickname = (value: string) => Array.from(value).slice(0, NICKNAME_MAX).join('')

/** 저장할 별칭 — 앞뒤 공백을 지우고 자른다. '' 이면 별칭 없음 */
export const normalizeNickname = (value: string) => clampNickname(value.trim()).trim()

/** 사용자 정의 그룹 — repos 는 "owner/name"(로컬 저장소는 LOCAL_OWNER/id) */
export type RepoGroup = { name: string; repos: string[] }

/** 이름은 별칭과 같은 규칙(앞뒤 공백 없음, NICKNAME_MAX 글자)으로 정리하고, 저장소는 대소문자를 가리지 않고 한 번만 둔다 */
export function normalizeGroup(group: RepoGroup): RepoGroup {
  const seen = new Set<string>()
  const repos = group.repos.filter((r) => {
    const i = r.indexOf('/')
    const key = r.toLowerCase()
    if (i <= 0 || i === r.length - 1 || seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { name: normalizeNickname(group.name), repos }
}

export function newGroupId(random: () => number = Math.random): string {
  return `g-${Math.floor(random() * 0x100000000)
    .toString(16)
    .padStart(8, '0')}`
}

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
  /** 저장소 별칭: repoKey → 별칭(앞뒤 공백 없음, 비지 않음) */
  nicknames: Record<string, string>
  /** 그룹 id → 그룹. 목록이 아니라 id 로 둔다 — 다른 기기와 맞출 때 그룹 단위로 합쳐진다(lib/sharedState merge3) */
  groups: Record<string, RepoGroup>

  addGitHub(owner: string, name: string): void
  removeGitHub(owner: string, name: string): void
  addLocal(repo: Pick<LocalRepo, 'hostId' | 'path' | 'displayName'>): string
  removeLocal(id: string): void
  addTask(id: string, title: string): number | null
  setTaskState(id: string, number: number, state: LocalTask['state']): void
  renameTask(id: string, number: number, title: string): void
  setPublish(id: string, publish: PublishProgress | null): void
  setLastParent(hostId: string, path: string): void
  /** 앞뒤 공백을 지우고 NICKNAME_MAX 글자로 자른다. 비거나 null 이면 별칭을 지운다 */
  setNickname(owner: string, repo: string, nickname: string | null): void
  /** 그룹을 만들거나(id 가 null) 고친다. 이름이 비면 저장하지 않고 null. 저장한 그룹의 id 를 돌려준다 */
  saveGroup(id: string | null, group: RepoGroup): string | null
  removeGroup(id: string): void
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
      nicknames: {},
      groups: {},
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
      renameTask: (id, number, title) =>
        set((s) => {
          const repo = s.local[id]
          if (!repo) return s
          return { local: { ...s.local, [id]: { ...repo, tasks: repo.tasks.map((t) => (t.number === number ? { ...t, title } : t)) } } }
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
      setNickname: (owner, repo, nickname) =>
        set((s) => {
          const key = repoKey(owner, repo)
          const value = normalizeNickname(nickname ?? '')
          if ((s.nicknames[key] ?? '') === value) return s
          const nicknames = { ...s.nicknames }
          if (value === '') delete nicknames[key]
          else nicknames[key] = value
          return { nicknames }
        }),
      saveGroup: (id, group) => {
        const value = normalizeGroup(group)
        if (value.name === '') return null
        let key = id
        while (key === null || (id === null && get().groups[key])) key = newGroupId()
        const saved = key
        set((s) => ({ groups: { ...s.groups, [saved]: value } }))
        return saved
      },
      removeGroup: (id) =>
        set((s) => {
          if (!(id in s.groups)) return s
          const groups = { ...s.groups }
          delete groups[id]
          return { groups }
        }),
    }),
    // 창이 여럿이어도 이 창이 바꾼 값만 쓴다(#105)
    { name: 'minmo-repos', storage: createJSONStorage(() => perWindowStorage([])) },
  ),
)
followOtherWindows('minmo-repos', () => useReposStore.persist.rehydrate())

/** "owner/name" → [owner, name] */
export function splitFullName(full: string): [string, string] {
  const i = full.indexOf('/')
  return [full.slice(0, i), full.slice(i + 1)]
}

type NameState = Pick<ReposState, 'local' | 'nicknames'>

export function repoNicknameOf(s: Pick<ReposState, 'nicknames'>, owner: string, repo: string): string | undefined {
  return s.nicknames[repoKey(owner, repo)]
}

/** 소유자 없이 보일 이름(트리) — 별칭, 로컬 저장소는 폴더명, GitHub 저장소는 name. 경로 템플릿 {alias} 의 값이기도 하다 */
export function repoShortNameOf(s: NameState, owner: string, repo: string): string {
  return repoNicknameOf(s, owner, repo) ?? (isLocalOwner(owner) ? (s.local[repo]?.displayName ?? repo) : repo)
}

/** 화면에 보일 저장소 이름 — 별칭, 로컬 저장소는 폴더명, GitHub 저장소는 owner/name */
export function repoLabelOf(s: NameState, owner: string, repo: string): string {
  return repoNicknameOf(s, owner, repo) ?? (isLocalOwner(owner) ? (s.local[repo]?.displayName ?? repo) : `${owner}/${repo}`)
}

/**
 * 이 PC 가 아는 다른 저장소(별칭이 있는 것·로컬 저장소·직접 추가한 저장소)에 같은 짧은 이름이 있는가(대소문자 무시).
 * 경로 템플릿 {alias} 가 겹치는지 미리 알리는 데 쓴다 — GitHub 목록에서만 보이는 저장소는 store 에 없어 보지 못한다
 */
export function shortNameTaken(s: Pick<ReposState, 'local' | 'nicknames' | 'added'>, owner: string, repo: string, nickname: string): boolean {
  const v = normalizeNickname(nickname).toLowerCase()
  if (v === '') return false
  const keys = new Set([...Object.keys(s.nicknames), ...Object.keys(s.local).map((id) => repoKey(LOCAL_OWNER, id)), ...s.added.map((a) => a.toLowerCase())])
  keys.delete(repoKey(owner, repo))
  return [...keys].some((k) => {
    const [o, r] = splitFullName(k)
    return repoShortNameOf(s, o, r).toLowerCase() === v
  })
}

/** 별칭 대신 보일 원래 이름(툴팁) — 로컬 저장소는 폴더 경로, GitHub 저장소는 owner/name */
export function repoFullNameOf(s: Pick<ReposState, 'local'>, owner: string, repo: string): string {
  return isLocalOwner(owner) ? (s.local[repo]?.path ?? repo) : `${owner}/${repo}`
}

export function useRepoLabel(owner: string, repo: string): string {
  return useReposStore((s) => repoLabelOf(s, owner, repo))
}

export function useRepoShortName(owner: string, repo: string): string {
  return useReposStore((s) => repoShortNameOf(s, owner, repo))
}

/** 별칭이 있을 때만 원래 이름(툴팁에 쓴다), 없으면 undefined */
export function useRepoFullNameIfNicknamed(owner: string, repo: string): string | undefined {
  return useReposStore((s) => (repoNicknameOf(s, owner, repo) !== undefined ? repoFullNameOf(s, owner, repo) : undefined))
}
