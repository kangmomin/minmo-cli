// 데이터 출처 — 서버 모드(PC 의 minmo 서버, SSH 역터널)와 로컬 모드(이 기기의 config.json + 서버 사본)를
// 같은 모양으로 감싼다. 명령·TUI 는 모드를 몰라도 되게 ctx.data 만 쓴다.
import { ApiError } from '@minmo/api-client'
import type { ApiClient, Me, SettingsField, SettingsInput, SettingsScope, SettingsValues } from '@minmo/api-client'
import { DEFAULT_SETTINGS, SETTING_FIELDS, isOfflineError, mergeSettings, validateSettingValue } from '@minmo/core'
import type { RepoSelection } from '@minmo/core'

import { CliError, serverErrorMessage } from './errors'
import type { ServerTarget } from './server'
import { updateConfig, updateState } from './store'
import type { Config, Credentials, LocalScope, Mode, Paths, State } from './store'

/** server: 서버 값 · local: 로컬에서 고른 값 · copy: 서버 사본 · default: 고른 적 없음(전체 표시) */
export type SelectionOrigin = 'server' | 'local' | 'copy' | 'default'
export type Selection = { repos: RepoSelection; origin: SelectionOrigin }
/** 값과 필드별 출처(사람이 읽는 이름) */
export type EffectiveView = { values: SettingsValues; sources: Record<SettingsField, string> }
/** 한 scope 에 저장된 값 — null 은 이 scope 에 값 없음(아래 층을 씀) */
export type ScopeValues = Record<SettingsField, string | null>

export interface Backend {
  readonly mode: Mode
  /** 서버 모드: 로그인·계정 확인. 로컬 모드: 확인할 것 없음(login null) */
  ready(): Promise<{ login: string | null }>
  getSelection(): Promise<Selection>
  /** 현재 선택을 바꿔 저장하고 저장된 값을 돌려준다 */
  updateSelection(change: (cur: string[] | null) => string[] | null): Promise<RepoSelection>
  /** 로컬 모드 전용 — 로컬 선택을 지워 서버 사본으로 돌아간다 */
  resetSelection(): Promise<void>
  getEffective(owner: string, repo: string): Promise<EffectiveView>
  getScope(scope: SettingsScope): Promise<ScopeValues>
  /** null: 서버 모드는 상속(조직·프로젝트), 로컬 모드는 로컬 값을 지움(모든 scope) */
  setSetting(scope: SettingsScope, key: SettingsField, value: string | null): Promise<void>
}

const repoKey = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase()
const SERVER_SOURCE: Record<string, string> = { global: '전역', org: '조직', project: '프로젝트' }

/**
 * 로그인 확인 + 서버 계정 확인. 소켓·포트가 다른 서버로 연결돼 있으면(다른 사용자의 터널 등) 저장된 로그인과 달라 막는다.
 */
export async function checkLogin(api: ApiClient, creds: Credentials | null, server: ServerTarget): Promise<Me> {
  if (!creds?.session) throw new CliError('로그인이 필요합니다 — 데스크탑의 "원격 CLI 접속"에서 코드를 발급해 `minmo login <코드>` 하세요(서버 없이 쓰려면 `minmo mode local`)')
  let me: Me
  try {
    me = await api.me()
  } catch (e) {
    throw new CliError(serverErrorMessage(e, server))
  }
  if (me.githubLogin !== creds.login) {
    throw new CliError(`연결된 서버의 계정(${me.githubLogin})이 로그인한 계정(${creds.login})과 다릅니다 — SSH 터널이 다른 서버로 연결됐을 수 있습니다`)
  }
  return me
}

type ServerDeps = { api: ApiClient; server: ServerTarget; creds: Credentials | null; paths: Paths; state: State }

/** 서버에서 받은 값을 사본으로 남긴다(로컬 모드의 기본값) — 사본 저장 실패는 본 작업을 막지 않는다 */
export function saveCopy(d: Pick<ServerDeps, 'paths' | 'state'>, change: (s: State) => void): Promise<void> {
  const at = new Date().toISOString()
  return updateState(d.paths, d.state, (s) => {
    change(s)
    s.serverCopy.syncedAt = at
  }).catch(() => undefined)
}

const isComplete = (r: Record<SettingsField, string | null>): r is SettingsValues => SETTING_FIELDS.every((f) => typeof r[f] === 'string')

export function serverBackend(d: ServerDeps): Backend {
  const fail = (e: unknown) => new CliError(serverErrorMessage(e, d.server))

  async function getScope(scope: SettingsScope): Promise<ScopeValues> {
    const rec = await d.api.getSettings(scope).catch((e: unknown) => {
      throw fail(e)
    })
    const values = Object.fromEntries(SETTING_FIELDS.map((f) => [f, rec[f]])) as ScopeValues
    if (scope.kind === 'global' && isComplete(values)) {
      const copy = { ...values }
      await saveCopy(d, (s) => {
        s.serverCopy.global = copy
      })
    }
    return values
  }

  return {
    mode: 'server',
    ready: async () => ({ login: (await checkLogin(d.api, d.creds, d.server)).githubLogin }),

    async getSelection() {
      try {
        const { repos } = await d.api.getVisibleRepos()
        await saveCopy(d, (s) => (s.serverCopy.visibleRepos = repos))
        return { repos, origin: 'server' }
      } catch (e) {
        // 터널이 잠깐 끊겨도 목록이 비지 않게 전체 표시
        if (isOfflineError(e)) return { repos: null, origin: 'default' }
        throw fail(e)
      }
    },

    // 읽고 → 바꾸고 → baseUpdatedAt 으로 저장. 다른 기기가 먼저 바꿨으면(409) 한 번 다시 시도한다
    async updateSelection(change) {
      for (let attempt = 0; ; attempt++) {
        const cur = await d.api.getVisibleRepos().catch((e: unknown) => {
          throw fail(e)
        })
        try {
          const { repos } = await d.api.putVisibleRepos({ repos: change(cur.repos), baseUpdatedAt: cur.updatedAt })
          await saveCopy(d, (s) => (s.serverCopy.visibleRepos = repos))
          return repos
        } catch (e) {
          if (e instanceof ApiError && e.code === 'conflict') {
            if (attempt === 0) continue
            throw new CliError('다른 기기에서 먼저 바뀌었습니다 — 새로고침 후 다시 시도하세요')
          }
          if (e instanceof ApiError && e.code === 'invalid_visible_repos') throw new CliError('형식이 올바르지 않습니다 — "owner/repo" 또는 "owner/*"')
          throw e instanceof CliError ? e : fail(e)
        }
      }
    },

    resetSelection: async () => {
      throw new CliError('`minmo repos reset` 은 로컬 모드 전용입니다 — 서버 모드에서 전체 표시는 `minmo repos all`', 2)
    },

    async getEffective(owner, repo) {
      const k = repoKey(owner, repo)
      try {
        const eff = await d.api.getEffective(owner, repo)
        await saveCopy(d, (s) => (s.effective[k] = eff))
        return { values: eff.values, sources: Object.fromEntries(SETTING_FIELDS.map((f) => [f, SERVER_SOURCE[eff.sources[f]] ?? eff.sources[f]])) as EffectiveView['sources'] }
      } catch (e) {
        // 터널이 끊겨도 한 번 받아 둔 설정으로는 열 수 있게(worktree 서비스가 offline 을 안내한다)
        const cached = d.state.effective[k]
        if (cached && isOfflineError(e)) return { values: cached.values, sources: Object.fromEntries(SETTING_FIELDS.map((f) => [f, '서버 사본'])) as EffectiveView['sources'] }
        throw e
      }
    },

    getScope,

    // 서버 PUT 은 레코드 전체 교체라 현재 값을 읽어 그 키만 바꿔 보낸다
    async setSetting(scope, key, value) {
      if (value === null && scope.kind === 'global') throw new CliError('전역 설정은 상속(-)할 수 없습니다', 2)
      const input: SettingsInput = { ...(await getScope(scope)), [key]: value }
      try {
        await d.api.putSettings(scope, input)
      } catch (e) {
        if (e instanceof ApiError && e.field) throw new CliError(`${e.field} 값이 올바르지 않습니다(${e.code})`)
        throw fail(e)
      }
    },
  }
}

const NAME = /^[a-z0-9_.-]{1,100}$/
const validName = (s: string) => NAME.test(s) && s !== '.' && s !== '..'

/** 서버 repofilter.Normalize 와 같은 규칙: 소문자 "owner/repo" 또는 "owner/*", 정렬·중복 제거, 최대 1000 */
export function normalizeSelection(entries: string[]): string[] {
  const bad = () => new CliError('형식이 올바르지 않습니다 — "owner/repo" 또는 "owner/*"')
  if (entries.length > 1000) throw bad()
  const out = entries.map((e) => {
    const t = e.trim().toLowerCase()
    const i = t.indexOf('/')
    const owner = t.slice(0, i)
    const repo = t.slice(i + 1)
    if (i < 0 || !validName(owner) || (repo !== '*' && !validName(repo))) throw bad()
    return `${owner}/${repo}`
  })
  return [...new Set(out)].sort()
}

type LocalDeps = { paths: Paths; state: State; config: Config }

export function localBackend(d: LocalDeps): Backend {
  const bagOf = (local: Config['local'], scope: SettingsScope, create: boolean): LocalScope | undefined => {
    if (scope.kind === 'global') return local.global
    const map = scope.kind === 'org' ? local.orgs : local.projects
    const k = scope.kind === 'org' ? scope.owner.toLowerCase() : repoKey(scope.owner, scope.repo)
    if (create) map[k] ??= {}
    return map[k]
  }

  function getSelection(): Selection {
    const l = d.config.local
    if (l.visibleRepos !== undefined) return { repos: l.visibleRepos, origin: 'local' }
    const c = d.state.serverCopy.visibleRepos
    if (c !== undefined) return { repos: c, origin: 'copy' }
    return { repos: null, origin: 'default' }
  }

  return {
    mode: 'local',
    ready: async () => ({ login: null }),
    getSelection: async () => getSelection(),

    async updateSelection(change) {
      const next = change(getSelection().repos)
      const repos = next === null ? null : normalizeSelection(next)
      await updateConfig(d.paths, d.config, (c) => {
        c.local.visibleRepos = repos
      })
      return repos
    },

    async resetSelection() {
      await updateConfig(d.paths, d.config, (c) => {
        delete c.local.visibleRepos
      })
    },

    // 기본값 ← 서버 사본(전역 → 그 저장소의 조직·프로젝트 값) ← 로컬 전역 ← 로컬 조직 ← 로컬 프로젝트
    async getEffective(owner, repo) {
      const copy = d.state.serverCopy.global
      const eff = d.state.effective[repoKey(owner, repo)]
      // 전역 사본이 있으면 저장소 사본에서는 조직·프로젝트 값만 쓴다(저장소 사본에 섞인 전역 값은 더 오래됐을 수 있다)
      const repoCopy = eff && Object.fromEntries(SETTING_FIELDS.filter((f) => !copy || eff.sources[f] !== 'global').map((f) => [f, eff.values[f]]))
      const l = d.config.local
      return mergeSettings<string>({ ...DEFAULT_SETTINGS }, '기본값', [
        { source: '서버 사본', values: copy },
        { source: '서버 사본', values: repoCopy },
        { source: '로컬 전역', values: l.global },
        { source: '로컬 조직', values: l.orgs[owner.toLowerCase()] },
        { source: '로컬 프로젝트', values: l.projects[repoKey(owner, repo)] },
      ])
    },

    async getScope(scope) {
      const bag = bagOf(d.config.local, scope, false) ?? {}
      return Object.fromEntries(SETTING_FIELDS.map((f) => [f, bag[f] ?? null])) as ScopeValues
    },

    async setSetting(scope, key, value) {
      if (value !== null) {
        const code = validateSettingValue(key, value)
        if (code) throw new CliError(`${key} 값이 올바르지 않습니다(${code})`)
      }
      await updateConfig(d.paths, d.config, (c) => {
        const bag = bagOf(c.local, scope, value !== null)
        if (!bag) return
        if (value === null) delete bag[key]
        else bag[key] = value
        // 비어 버린 조직·프로젝트 항목은 지운다
        if (scope.kind !== 'global' && Object.keys(bag).length === 0) {
          if (scope.kind === 'org') delete c.local.orgs[scope.owner.toLowerCase()]
          else delete c.local.projects[repoKey(scope.owner, scope.repo)]
        }
      })
    },
  }
}
