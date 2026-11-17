// 데스크탑과 공유하는 데이터(보일 저장소·설정) — PC 의 minmo 서버(SSH 역터널) 값을 읽고 쓴다.
import { ApiError } from '@minmo/api-client'
import type { ApiClient, Effective, Me, SettingsField, SettingsInput, SettingsRecord, SettingsScope, SettingsSource } from '@minmo/api-client'
import { SETTING_FIELDS } from '@minmo/core'
import type { RepoSelection } from '@minmo/core'

import { CliError, serverErrorMessage } from './errors'
import type { ServerTarget } from './server'
import type { Credentials } from './store'

export const SOURCE_LABEL: Record<SettingsSource, string> = {
  global: '전역',
  org: '조직',
  project: '프로젝트',
}
/** 한 scope 에 저장된 값 — null 은 이 scope 에 값 없음(상속) */
export type ScopeValues = Record<SettingsField, string | null> & { updatedAt?: string | null }

/** 서버 호출만 감싼다 — 로그인 확인은 명령이 requireLogin 으로 먼저 한다 */
export interface Backend {
  getSelection(): Promise<RepoSelection>
  /** 현재 선택을 바꿔 저장하고 저장된 값을 돌려준다 */
  updateSelection(change: (cur: string[] | null) => string[] | null): Promise<RepoSelection>
  getEffective(owner: string, repo: string): Promise<Effective>
  getScope(scope: SettingsScope): Promise<ScopeValues>
  /** null: 상속(조직·프로젝트) */
  setSetting(scope: SettingsScope, key: SettingsField, value: string | null): Promise<void>
}

/**
 * 로그인 확인 + 서버 계정 확인. 소켓·포트가 다른 서버로 연결돼 있으면(다른 사용자의 터널 등) 저장된 로그인과 달라 막는다.
 */
export async function checkLogin(api: ApiClient, creds: Credentials | null, server: ServerTarget): Promise<Me> {
  if (!creds?.session) throw new CliError('로그인이 필요합니다 — 데스크탑의 "원격 CLI 접속"에서 코드를 발급해 `minmo login <코드>` 하세요')
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

type ServerDeps = { api: ApiClient; server: ServerTarget }

export function serverBackend(d: ServerDeps): Backend {
  const fail = (e: unknown) => new CliError(serverErrorMessage(e, d.server))
  const fields = (rec: SettingsRecord) => Object.fromEntries(SETTING_FIELDS.map((f) => [f, rec[f]])) as Record<SettingsField, string | null>

  return {
    getSelection: () =>
      d.api.getVisibleRepos().then(
        (v) => v.repos,
        (e: unknown) => {
          throw fail(e)
        },
      ),

    // 읽고 → 바꾸고 → baseUpdatedAt 으로 저장. 다른 기기가 먼저 바꿨으면(409) 한 번 다시 시도한다
    async updateSelection(change) {
      for (let attempt = 0; ; attempt++) {
        const cur = await d.api.getVisibleRepos().catch((e: unknown) => {
          throw fail(e)
        })
        try {
          const { repos } = await d.api.putVisibleRepos({ repos: change(cur.repos), baseUpdatedAt: cur.updatedAt })
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

    getEffective: (owner, repo) => d.api.getEffective(owner, repo),

    async getScope(scope) {
      const rec = await d.api.getSettings(scope).catch((e: unknown) => {
        throw fail(e)
      })
      return { ...fields(rec), updatedAt: rec.updatedAt }
    },

    // 서버 PUT 은 레코드 전체 교체라 현재 값을 읽어 그 키만 바꿔 보낸다
    async setSetting(scope, key, value) {
      if (value === null && scope.kind === 'global') throw new CliError('전역 설정은 상속(-)할 수 없습니다', 2)
      const rec = await d.api.getSettings(scope).catch((e: unknown) => {
        throw fail(e)
      })
      const input: SettingsInput = { ...fields(rec), [key]: value }
      try {
        await d.api.putSettings(scope, input)
      } catch (e) {
        if (e instanceof ApiError && e.field) throw new CliError(`${e.field} 값이 올바르지 않습니다(${e.code})`)
        throw fail(e)
      }
    },
  }
}
