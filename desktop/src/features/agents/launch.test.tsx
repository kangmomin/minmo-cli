// [에이전트 실행] — 명령 만들기(따옴표·한 줄·빈 지시문), 실행할 패널 마련, 대화상자, 터미널이 준비되면 명령 넣기
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { IssueTarget } from '@minmo/core'

import { HostScope } from '../../app/host'
import { useHostsStore } from '../../store/hosts'
import { useUiStore } from '../../store/ui'
import { makeDeps, renderWithDeps } from '../../test/render'
import { leafIds } from '../terminal/panes'
import { LaunchAgentDialog } from './LaunchAgentDialog'
import { DEFAULT_AGENT_COMMANDS, buildCommand, defaultPrompt, oneLine, quoteArg } from './launch'
import { queueLaunch, takeLaunch } from './launchQueue'

const ISSUE = 'acme/app#42'
const TARGET: IssueTarget = { owner: 'acme', repo: 'app', key: '42', number: 42, title: 'Add login' }

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState({ panes: {}, terminalIds: {}, focusRequest: null, tab: 'notes', agentCommands: DEFAULT_AGENT_COMMANDS, lastLaunchKind: 'claude', launchRequest: null })
  useHostsStore.setState({ probes: {} })
})

describe('명령 만들기', () => {
  it('quoteArg: 작은따옴표로 감싸고 안의 작은따옴표는 셸에 맞게 — 변수·명령 치환 글자는 그대로 글자다', () => {
    expect(quoteArg("it's $HOME `x` \"y\"", 'posix')).toBe(`'it'\\''s $HOME \`x\` "y"'`)
    expect(quoteArg("it's $env:X `x`", 'powershell')).toBe(`'it''s $env:X \`x\`'`)
    expect(quoteArg('', 'posix')).toBe("''")
  })

  it('quoteArg(PowerShell): 큰따옴표·둥근 따옴표·끝의 \\ 로 인자가 쪼개지거나 문자열이 닫히지 않는다', () => {
    // 큰따옴표는 작은따옴표로 바뀐다(그대로 두면 `x" --flag "y` 가 옵션으로 넘어간다)
    expect(quoteArg('x" --yolo "y', 'powershell')).toBe("'x'' --yolo ''y'")
    // 둥근 작은따옴표도 PowerShell 에서는 문자열을 닫는다
    expect(quoteArg('a\u2019; calc; \u2018b', 'powershell')).toBe("'a\u2019\u2019; calc; \u2018\u2018b'")
    expect(quoteArg('fix C:\\dir\\', 'powershell')).toBe("'fix C:\\dir\\\\'")
    expect(quoteArg('C:\\dir\\', 'powershell')).toBe("'C:\\dir\\'")
    // POSIX 셸에서는 둥근 따옴표·큰따옴표가 그냥 글자다
    expect(quoteArg('a\u2019 "b"', 'posix')).toBe("'a\u2019 \"b\"'")
  })

  it('oneLine: 줄바꿈·탭은 공백으로, 제어 문자(ESC 등)는 뺀다', () => {
    expect(oneLine('  첫 줄\r\n둘째 줄\t끝  ')).toBe('첫 줄 둘째 줄 끝')
    expect(oneLine('a\x1b[31mb\x07c\x7f')).toBe('a[31mbc')
  })

  it('buildCommand: {prompt} 자리에 감싼 지시문을 넣는다', () => {
    expect(buildCommand('claude {prompt}', "로그인 고쳐줘\n테스트도 it's", 'powershell')).toEqual({ ok: true, command: "claude '로그인 고쳐줘 테스트도 it''s'" })
    expect(buildCommand('codex {prompt}', 'fix; rm -rf /', 'posix')).toEqual({ ok: true, command: "codex 'fix; rm -rf /'" })
    expect(buildCommand('my-agent --task {prompt} --yes', 'x', 'posix')).toEqual({ ok: true, command: "my-agent --task 'x' --yes" })
  })

  it('buildCommand: 지시문이 비면 {prompt} 와 바로 앞의 옵션을 함께 뺀다', () => {
    expect(buildCommand('claude {prompt}', '  ', 'posix')).toEqual({ ok: true, command: 'claude' })
    expect(buildCommand('gemini -i {prompt}', '', 'posix')).toEqual({ ok: true, command: 'gemini' })
    expect(buildCommand('my-agent --task {prompt} --yes', '', 'posix')).toEqual({ ok: true, command: 'my-agent --yes' })
    expect(buildCommand('npm run agent', '', 'posix')).toEqual({ ok: true, command: 'npm run agent' })
  })

  it('buildCommand: 명령이 비었거나, {prompt} 자리 없이 지시문을 넘기려 하면 거절한다', () => {
    expect(buildCommand('  ', 'x', 'posix')).toMatchObject({ ok: false })
    expect(buildCommand('{prompt}', '', 'posix')).toMatchObject({ ok: false })
    expect(buildCommand('npm run agent', 'do it', 'posix')).toMatchObject({ ok: false, error: expect.stringContaining('{prompt}') })
    // 명령 틀에 섞인 줄바꿈으로 두 번째 명령이 실행되지 않는다
    expect(buildCommand('claude {prompt}\nrm -rf x', 'a', 'posix')).toEqual({ ok: true, command: "claude 'a' rm -rf x" })
  })

  it('defaultPrompt: 이슈 번호·제목(+GitHub 주소), 로컬 저장소의 작업은 주소 없이, 기타는 비움', () => {
    expect(defaultPrompt(TARGET)).toBe('#42 Add login (https://github.com/acme/app/issues/42)')
    expect(defaultPrompt({ owner: '_local', repo: 'my-app-1a2b', key: '3', number: 3, title: '로그인' })).toBe('#3 로그인')
    expect(defaultPrompt({ ...TARGET, key: 'etc', number: null, title: '' })).toBe('')
  })

  it('대기열: 맡긴 명령은 한 번만 꺼낸다', () => {
    queueLaunch('p1', 'claude')
    expect(takeLaunch('p1')).toBe('claude')
    expect(takeLaunch('p1')).toBeUndefined()
  })
})

describe('launchPane: 실행할 터미널 패널 마련', () => {
  const panes = () => useUiStore.getState().panes[ISSUE]

  it('터미널을 띄운 적이 없으면 첫 패널을 쓴다', () => {
    expect(useUiStore.getState().launchPane(ISSUE)).toBe(`${ISSUE}::1`)
    expect(leafIds(panes().tree)).toEqual([`${ISSUE}::1`])
    // 패널은 만들어졌지만 아직 터미널이 뜨지 않았으면(탭을 본 적 없음) 그 패널을 쓴다
    expect(useUiStore.getState().launchPane(ISSUE)).toBe(`${ISSUE}::1`)
    expect(leafIds(panes().tree)).toHaveLength(1)
  })

  it('이미 쓰는 터미널이 있으면 포커스한 패널 오른쪽에 새 패널을 만들고 그쪽으로 포커스를 옮긴다', () => {
    useUiStore.getState().ensurePanes(ISSUE)
    useUiStore.setState({ terminalIds: { [`${ISSUE}::1`]: 'pty-1' } })
    const id = useUiStore.getState().launchPane(ISSUE)
    expect(id).toBe(`${ISSUE}::2`)
    expect(leafIds(panes().tree)).toEqual([`${ISSUE}::1`, `${ISSUE}::2`])
    expect(panes().focused).toBe(id)
    expect(useUiStore.getState().focusRequest?.paneId).toBe(id)
  })

  it('패널을 모두 닫은 상태면 새 패널을 만든다(번호는 이어서)', () => {
    useUiStore.getState().ensurePanes(ISSUE)
    useUiStore.getState().closePane(ISSUE, `${ISSUE}::1`)
    expect(panes().tree).toBeNull()
    expect(useUiStore.getState().launchPane(ISSUE)).toBe(`${ISSUE}::2`)
    expect(leafIds(panes().tree)).toEqual([`${ISSUE}::2`])
  })
})

describe('LaunchAgentDialog', () => {
  function open(o: { platform?: 'win32' | 'linux'; alias?: string | null; target?: IssueTarget } = {}) {
    const onOpenChange = vi.fn()
    if (o.alias) useHostsStore.setState({ probes: { [o.alias]: { platform: 'linux', home: '/home/dev', git: 'git', tmux: true } } })
    renderWithDeps(
      <HostScope alias={o.alias ?? null}>
        <LaunchAgentDialog issueId={ISSUE} target={o.target ?? TARGET} open onOpenChange={onOpenChange} />
      </HostScope>,
      makeDeps({ platform: o.platform ?? 'win32' }),
    )
    return { user: userEvent.setup(), onOpenChange }
  }
  const preview = () => screen.getByTestId('launch-preview').textContent

  it('이슈 번호·제목이 지시문에 채워지고, 실행하면 새 패널에 명령을 맡기고 터미널 탭으로 간다(Windows = PowerShell 따옴표)', async () => {
    const { user, onOpenChange } = open()
    expect(screen.getByLabelText('지시문')).toHaveValue('#42 Add login (https://github.com/acme/app/issues/42)')
    expect(screen.getByRole('radio', { name: 'Claude Code' })).toBeChecked()
    await user.clear(screen.getByLabelText('지시문'))
    await user.type(screen.getByLabelText('지시문'), "it's 로그인")
    expect(preview()).toBe("claude 'it''s 로그인'")
    await user.click(screen.getByRole('button', { name: '실행' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(useUiStore.getState().tab).toBe('terminal')
    expect(takeLaunch(`${ISSUE}::1`)).toBe("claude 'it''s 로그인'")
  })

  it('에이전트를 바꾸면 그 명령 틀이 뜨고, 고친 명령과 고른 에이전트는 저장된다 · [기본값] 으로 되돌린다', async () => {
    const { user } = open({ platform: 'linux' })
    await user.click(screen.getByRole('radio', { name: 'Gemini CLI' }))
    expect(screen.getByLabelText('명령')).toHaveValue('gemini -i {prompt}')
    expect(preview()).toBe("gemini -i '#42 Add login (https://github.com/acme/app/issues/42)'")
    await user.clear(screen.getByLabelText('명령'))
    await user.type(screen.getByLabelText('명령'), 'gemini --yolo -i {{prompt}')
    await user.click(screen.getByRole('button', { name: '기본값' }))
    expect(screen.getByLabelText('명령')).toHaveValue('gemini -i {prompt}')
    await user.clear(screen.getByLabelText('명령'))
    await user.type(screen.getByLabelText('명령'), 'gemini --yolo -i {{prompt}')
    await user.click(screen.getByRole('button', { name: '실행' }))
    expect(useUiStore.getState().agentCommands.gemini).toBe('gemini --yolo -i {prompt}')
    expect(useUiStore.getState().lastLaunchKind).toBe('gemini')
    expect(JSON.parse(localStorage.getItem('minmo-ui') ?? '{}').state).toMatchObject({ lastLaunchKind: 'gemini', agentCommands: { gemini: 'gemini --yolo -i {prompt}', claude: 'claude {prompt}' } })
    expect(takeLaunch(`${ISSUE}::1`)).toContain('gemini --yolo -i ')
  })

  it('원격 호스트의 이슈는 POSIX 따옴표를 쓴다 · 직접 입력은 명령을 넣어야 실행할 수 있다', async () => {
    const { user } = open({ platform: 'win32', alias: 'srv' })
    await user.clear(screen.getByLabelText('지시문'))
    await user.type(screen.getByLabelText('지시문'), "it's")
    await waitFor(() => expect(preview()).toBe(`claude 'it'\\''s'`))
    await user.click(screen.getByRole('radio', { name: '직접 입력' }))
    expect(screen.getByRole('alert')).toHaveTextContent('실행할 명령을 입력하세요')
    expect(screen.getByRole('button', { name: '실행' })).toBeDisabled()
    await user.type(screen.getByLabelText('명령'), 'aider --message {{prompt}')
    expect(preview()).toBe(`aider --message 'it'\\''s'`)
    expect(screen.getByRole('button', { name: '실행' })).toBeEnabled()
  })

  it('기타(번호 없는 이슈)는 지시문을 비워 두고 에이전트만 띄운다', () => {
    open({ target: { ...TARGET, key: 'etc', number: null, title: '' } })
    expect(screen.getByLabelText('지시문')).toHaveValue('')
    expect(preview()).toBe('claude')
  })
})
