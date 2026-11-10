// 설정 다이얼로그 (F-07) — 근거: CT-08, CT-09, CT-12, CT-22, CT-28, AC-13, AC-15, EC-17,
// UI State Contract("settings 400" 인라인 오류·저장 버튼 활성 유지, placeholder = 상위 scope 값, postCreateScript 3상태)
//
// 접근성 계약(6.2 구현이 유지): 입력 라벨 "브랜치 템플릿" "기타 브랜치명" "worktree 경로" "메인 clone 경로",
// 라디오 그룹 "생성 후 스크립트"(라디오 "상속"/"없음"/"직접 입력"), 텍스트영역 "스크립트 내용", 버튼 "저장",
// 미리보기 data-testid "preview-branch" / "preview-path", 필드 오류는 aria-invalid="true".
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import type { SettingsInput, SettingsRecord, SettingsScope } from '@minmo/api-client'

import { useSessionStore } from '../../store/session'
import { apiError, createFakeApi } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { SettingsDialog } from './SettingsDialog'
import type { PreviewIssue } from './SettingsDialog'

const GLOBAL: SettingsRecord = {
  branchTemplate: 'issue/{number}-{slug}',
  etcBranchName: 'etc',
  worktreePath: '~/minmo-workspaces/{owner}/{repo}/{branch}',
  mainClonePath: '~/minmo-workspaces/{owner}/{repo}/_main',
  postCreateScript: '',
  updatedAt: '2026-11-09T00:00:00.000Z',
}
const EMPTY: SettingsRecord = {
  branchTemplate: null,
  etcBranchName: null,
  worktreePath: null,
  mainClonePath: null,
  postCreateScript: null,
  updatedAt: null,
}
const PROJECT: SettingsScope = { kind: 'project', owner: 'MyOrg', repo: 'Repo-A' }
const ORG: SettingsScope = { kind: 'org', owner: 'MyOrg' }
const ISSUE: PreviewIssue = { owner: 'MyOrg', repo: 'Repo-A', key: '42', number: 42, title: 'Add login' }

function setup(o: { scope: SettingsScope; org?: SettingsRecord; project?: SettingsRecord; global?: SettingsRecord; put?: (s: SettingsScope, i: SettingsInput) => Promise<SettingsRecord> }) {
  const api = createFakeApi({
    getSettings: async (s) => (s.kind === 'global' ? (o.global ?? GLOBAL) : s.kind === 'org' ? (o.org ?? EMPTY) : (o.project ?? EMPTY)),
    putSettings: o.put ?? (async () => EMPTY),
  })
  const user = userEvent.setup()
  renderWithDeps(<SettingsDialog scope={o.scope} open onOpenChange={() => {}} previewIssue={ISSUE} />, makeDeps({ api, home: '/home/u', platform: 'linux' }))
  return { api, user }
}

const field = (label: string) => screen.findByLabelText(label)

async function replace(user: ReturnType<typeof userEvent.setup>, el: HTMLElement, text: string) {
  await user.clear(el)
  await user.click(el)
  if (text) await user.paste(text)
}

beforeEach(() => {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
  useSessionStore.setState({ token: 'tok', status: 'online' })
})

describe('CT-22 행 없는 org/project → 모든 필드 "상속"', () => {
  it('프로젝트 폼: 값은 비어 있고 placeholder = "상속: <전역 값>", 스크립트는 "상속"', async () => {
    const { api } = setup({ scope: PROJECT })
    const branch = await field('브랜치 템플릿')
    await waitFor(() => expect(branch).toHaveAttribute('placeholder', '상속: issue/{number}-{slug}'))
    expect(branch).toHaveValue('')
    expect(await field('기타 브랜치명')).toHaveAttribute('placeholder', '상속: etc')
    expect(await field('worktree 경로')).toHaveAttribute('placeholder', '상속: ~/minmo-workspaces/{owner}/{repo}/{branch}')
    expect(await field('메인 clone 경로')).toHaveAttribute('placeholder', '상속: ~/minmo-workspaces/{owner}/{repo}/_main')
    expect(screen.getByRole('radio', { name: '상속' })).toBeChecked()
    // placeholder 출처: E6 + E8 + E10
    expect(api.getSettings).toHaveBeenCalledWith({ kind: 'global' })
    expect(api.getSettings).toHaveBeenCalledWith(ORG)
    expect(api.getSettings).toHaveBeenCalledWith(PROJECT)
  })

  it('조직 폼: placeholder 는 전역 값, 프로젝트 레코드는 조회하지 않음', async () => {
    const { api } = setup({ scope: ORG })
    const etc = await field('기타 브랜치명')
    await waitFor(() => expect(etc).toHaveAttribute('placeholder', '상속: etc'))
    expect(api.getSettings).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'project' }))
  })
})

describe('CT-12 / AC-15 조직 값 상속 표시', () => {
  it('조직 worktreePath 가 있으면 프로젝트 폼 placeholder "상속: ~/work/{owner}/{repo}/{key}", 미리보기 경로 반영', async () => {
    setup({ scope: PROJECT, org: { ...EMPTY, worktreePath: '~/work/{owner}/{repo}/{key}', updatedAt: '2026-11-09T00:00:01.000Z' } })
    const wt = await field('worktree 경로')
    await waitFor(() => expect(wt).toHaveAttribute('placeholder', '상속: ~/work/{owner}/{repo}/{key}'))
    expect(await field('브랜치 템플릿')).toHaveAttribute('placeholder', '상속: issue/{number}-{slug}')
    await waitFor(() => expect(screen.getByTestId('preview-path')).toHaveTextContent('/home/u/work/MyOrg/Repo-A/42'))
  })
})

describe('CT-09 / AC-13 프로젝트 브랜치 템플릿 override', () => {
  it('feat/{number} 입력 → 미리보기 feat/42, 저장 시 나머지 필드는 null(상속)', async () => {
    const { api, user } = setup({ scope: PROJECT, put: async (_s, i) => ({ ...EMPTY, ...i, updatedAt: '2026-11-09T00:00:02.000Z' }) as SettingsRecord })
    const branch = await field('브랜치 템플릿')
    await waitFor(() => expect(branch).toHaveAttribute('placeholder', '상속: issue/{number}-{slug}'))
    await replace(user, branch, 'feat/{number}')
    await waitFor(() => expect(screen.getByTestId('preview-branch')).toHaveTextContent('feat/42'))
    expect(screen.getByTestId('preview-path')).toHaveTextContent('/home/u/minmo-workspaces/MyOrg/Repo-A/feat--42')

    await user.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(api.putSettings).toHaveBeenCalledTimes(1))
    const [scope, input] = api.putSettings.mock.calls[0]
    expect(scope).toEqual(PROJECT)
    expect(input.branchTemplate).toBe('feat/{number}')
    expect(input.etcBranchName ?? null).toBeNull()
    expect(input.worktreePath ?? null).toBeNull()
    expect(input.mainClonePath ?? null).toBeNull()
    expect(input.postCreateScript ?? null).toBeNull()
  })

  it('미리보기 기본값: 상속 값으로 issue/42-add-login', async () => {
    setup({ scope: PROJECT })
    await waitFor(() => expect(screen.getByTestId('preview-branch')).toHaveTextContent('issue/42-add-login'))
    expect(screen.getByTestId('preview-path')).toHaveTextContent('/home/u/minmo-workspaces/MyOrg/Repo-A/issue--42-add-login')
  })
})

describe('CT-08 전역 400 global_requires_all_fields → 인라인 오류', () => {
  it('field 위치에 aria-invalid, 저장 버튼은 활성 유지', async () => {
    const { api, user } = setup({
      scope: { kind: 'global' },
      put: async () => {
        throw apiError(400, 'global_requires_all_fields', { field: 'worktreePath' })
      },
    })
    const wt = await field('worktree 경로')
    await waitFor(() => expect(wt).toHaveValue('~/minmo-workspaces/{owner}/{repo}/{branch}'))
    const save = screen.getByRole('button', { name: '저장' })
    await user.click(save)
    await waitFor(() => expect(api.putSettings).toHaveBeenCalled())
    await waitFor(() => expect(wt).toHaveAttribute('aria-invalid', 'true'))
    expect(await field('브랜치 템플릿')).not.toHaveAttribute('aria-invalid', 'true')
    expect(save).toBeEnabled()
  })

  it('전역 폼에는 "상속" 선택지가 없다 (전역은 모든 필드 non-null)', async () => {
    setup({ scope: { kind: 'global' } })
    await field('브랜치 템플릿')
    expect(screen.queryByRole('radio', { name: '상속' })).toBeNull()
    await waitFor(() => expect(screen.getByRole('radio', { name: '없음' })).toBeChecked())
  })
})

describe('CT-28 postCreateScript 3상태 · etcBranchName 오류', () => {
  it('"없음" 선택 → postCreateScript "" 로 저장(override)', async () => {
    const { api, user } = setup({ scope: ORG })
    await field('브랜치 템플릿')
    await user.click(screen.getByRole('radio', { name: '없음' }))
    await user.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(api.putSettings).toHaveBeenCalledTimes(1))
    expect(api.putSettings.mock.calls[0][1].postCreateScript).toBe('')
  })

  it('"직접 입력" 선택 → 스크립트 내용으로 저장', async () => {
    const { api, user } = setup({ scope: ORG })
    await field('브랜치 템플릿')
    await user.click(screen.getByRole('radio', { name: '직접 입력' }))
    await replace(user, await field('스크립트 내용'), 'npm ci')
    await user.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(api.putSettings).toHaveBeenCalledTimes(1))
    expect(api.putSettings.mock.calls[0][1].postCreateScript).toBe('npm ci')
  })

  it('"상속" 유지 → postCreateScript null', async () => {
    const { api, user } = setup({ scope: ORG })
    await field('브랜치 템플릿')
    await user.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(api.putSettings).toHaveBeenCalledTimes(1))
    expect(api.putSettings.mock.calls[0][1].postCreateScript ?? null).toBeNull()
  })

  it('저장된 "" 은 "없음", 저장된 본문은 "직접 입력" 으로 표시', async () => {
    setup({ scope: ORG, org: { ...EMPTY, postCreateScript: '', updatedAt: '2026-11-09T00:00:01.000Z' } })
    await waitFor(() => expect(screen.getByRole('radio', { name: '없음' })).toBeChecked())
  })

  it('저장된 스크립트 본문 → "직접 입력" + 내용 표시', async () => {
    setup({ scope: PROJECT, project: { ...EMPTY, postCreateScript: 'npm ci', updatedAt: '2026-11-09T00:00:01.000Z' } })
    await waitFor(() => expect(screen.getByRole('radio', { name: '직접 입력' })).toBeChecked())
    expect(await field('스크립트 내용')).toHaveValue('npm ci')
  })

  it('400 invalid_template field=etcBranchName → 기타 브랜치명 인라인 오류', async () => {
    const { user } = setup({
      scope: ORG,
      put: async () => {
        throw apiError(400, 'invalid_template', { field: 'etcBranchName' })
      },
    })
    const etc = await field('기타 브랜치명')
    await replace(user, etc, 'a b')
    await user.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(etc).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByRole('button', { name: '저장' })).toBeEnabled()
  })
})

describe('EC-17 서버 미연결 → 설정 편집 비활성', () => {
  it('status offline 이면 저장 비활성', async () => {
    useSessionStore.setState({ status: 'offline' })
    setup({ scope: PROJECT })
    await field('브랜치 템플릿')
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled()
  })
})

describe('AX 오류 안내 연결', () => {
  it('스크립트 내용 textarea 는 안내 문단과 aria-describedby 로 연결, 오류는 role=alert', async () => {
    const { user } = setup({
      scope: ORG,
      put: async () => {
        throw apiError(400, 'script_too_large', { field: 'postCreateScript' })
      },
    })
    await field('브랜치 템플릿')
    await user.click(screen.getByRole('radio', { name: '직접 입력' }))
    const script = await field('스크립트 내용')
    expect(script).toHaveAccessibleDescription(/worktree 생성 직후 1회 실행/)
    await replace(user, script, 'echo hi')
    await user.click(screen.getByRole('button', { name: '저장' }))
    await waitFor(() => expect(script).toHaveAttribute('aria-invalid', 'true'))
    const alert = screen.getByRole('alert')
    expect(script.getAttribute('aria-describedby')).toContain(alert.id)
  })

  it('field 없는 저장 실패(formError) 는 role=alert', async () => {
    const { user } = setup({
      scope: ORG,
      put: async () => {
        throw apiError(429, 'http_error')
      },
    })
    await field('브랜치 템플릿')
    await user.click(screen.getByRole('button', { name: '저장' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('저장 실패(http_error)')
  })

  it('텍스트 필드 오류도 role=alert 로 알린다', async () => {
    const { user } = setup({
      scope: ORG,
      put: async () => {
        throw apiError(400, 'invalid_template', { field: 'etcBranchName' })
      },
    })
    const etc = await field('기타 브랜치명')
    await replace(user, etc, 'a b')
    await user.click(screen.getByRole('button', { name: '저장' }))
    const alert = await screen.findByRole('alert')
    expect(etc.getAttribute('aria-describedby')).toContain(alert.id)
  })

  it('AX-20 오류가 나도 힌트 <p> 는 그대로(role 없음), 오류는 별도 alert 노드, aria-describedby 는 힌트+오류 둘 다', async () => {
    const { user } = setup({
      scope: ORG,
      put: async () => {
        throw apiError(400, 'invalid_template', { field: 'etcBranchName' })
      },
    })
    const etc = await field('기타 브랜치명')
    const hintId = etc.getAttribute('aria-describedby')!
    const hint = document.getElementById(hintId)!
    expect(hint).toHaveTextContent('★기타 이슈의 브랜치')
    expect(screen.queryByRole('alert')).toBeNull()

    await replace(user, etc, 'a b')
    await user.click(screen.getByRole('button', { name: '저장' }))
    const alert = await screen.findByRole('alert')
    // 힌트는 같은 요소·같은 내용·role 없음 — role 을 status↔alert 로 바꾸지 않는다
    expect(document.getElementById(hintId)).toBe(hint)
    expect(hint).toHaveTextContent('★기타 이슈의 브랜치')
    expect(hint).not.toHaveAttribute('role')
    expect(alert).toHaveTextContent('템플릿 형식이 올바르지 않습니다')
    expect(alert).not.toBe(hint)
    expect(etc.getAttribute('aria-describedby')?.split(' ')).toEqual([hintId, alert.id])
    expect(etc).toHaveAccessibleDescription(/★기타 이슈의 브랜치.*템플릿 형식이 올바르지 않습니다/)
  })

  it('AX-20 스크립트 필드도 힌트 유지 + 별도 alert, describedby 둘 다', async () => {
    const { user } = setup({
      scope: ORG,
      put: async () => {
        throw apiError(400, 'script_too_large', { field: 'postCreateScript' })
      },
    })
    await field('브랜치 템플릿')
    await user.click(screen.getByRole('radio', { name: '직접 입력' }))
    const script = await field('스크립트 내용')
    const hintId = script.getAttribute('aria-describedby')!
    await replace(user, script, 'echo hi')
    await user.click(screen.getByRole('button', { name: '저장' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('스크립트가 64 KiB 를 넘습니다')
    expect(document.getElementById(hintId)).toHaveTextContent(/worktree 생성 직후 1회 실행/)
    expect(document.getElementById(hintId)).not.toHaveAttribute('role')
    expect(script.getAttribute('aria-describedby')?.split(' ')).toEqual([hintId, alert.id])
  })
})
