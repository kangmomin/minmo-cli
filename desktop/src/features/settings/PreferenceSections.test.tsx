// 설정 화면 — 모양·알림·표시·에이전트 분류(바꾸면 바로 저장되는 칸)
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { THEMES, THEME_LABEL } from '../../lib/theme'
import { FONT_SIZE, useUiStore } from '../../store/ui'
import { makeDeps, renderWithDeps } from '../../test/render'
import { DEFAULT_AGENT_COMMANDS, LAUNCH_KINDS, LAUNCH_LABEL, buildCommand } from '../agents/launch'
import type { LaunchKind } from '../agents/launch'
import { AgentCommandsSection, AppearanceSection, NotifySection } from './PreferenceSections'

const NOTIFY_LABEL = '에이전트가 작업을 끝내거나 입력을 기다리면 알림 띄우기'
const USAGE_LABEL = '하단 바에 AI 별 사용량 표시'
const NO_PROMPT_HINT = /지시문 없이 실행할 때만 쓸 수 있습니다/

// EC-12: 화면의 오류 문구는 실행 대화상자와 같은 검사(buildCommand)의 오류다
const QUOTED = buildCommand('claude "{prompt}"', '', 'posix')
const QUOTED_ERROR = QUOTED.ok ? '(buildCommand 가 오류를 내지 않음)' : QUOTED.error

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState({ theme: 'ghostty', fontSize: FONT_SIZE.default, agentNotify: true, showUsage: true, agentCommands: DEFAULT_AGENT_COMMANDS })
})

const stored = () => useUiStore.getState().agentCommands
const field = (kind: LaunchKind) => screen.getByRole('textbox', { name: LAUNCH_LABEL[kind] })
const resetButton = (kind: LaunchKind) => screen.getByRole('button', { name: `${LAUNCH_LABEL[kind]} 기본값` })

function renderAgents() {
  const user = userEvent.setup()
  renderWithDeps(<AgentCommandsSection />, makeDeps())
  return { user }
}

describe('AppearanceSection', () => {
  it('AC-06 테마 라디오를 고르면 theme 이 바로 바뀐다', async () => {
    const user = userEvent.setup()
    renderWithDeps(<AppearanceSection />, makeDeps())
    const group = screen.getByRole('radiogroup', { name: '테마' })
    expect(within(group).getAllByRole('radio')).toHaveLength(THEMES.length)
    expect(within(group).getByRole('radio', { name: THEME_LABEL.ghostty })).toBeChecked()
    await user.click(within(group).getByRole('radio', { name: THEME_LABEL.black }))
    expect(useUiStore.getState().theme).toBe('black')
    expect(within(group).getByRole('radio', { name: THEME_LABEL.black })).toBeChecked()
    await user.click(within(group).getByRole('radio', { name: THEME_LABEL.light }))
    expect(useUiStore.getState().theme).toBe('light')
  })

  it('AC-06 글자 크기는 범위 안 정수면 바로 적용되고 [기본값] 은 13 으로 되돌린다', async () => {
    const user = userEvent.setup()
    renderWithDeps(<AppearanceSection />, makeDeps())
    const input = screen.getByRole('spinbutton', { name: '글자 크기(터미널·파일 편집기)' })
    await user.clear(input)
    await user.type(input, '20')
    expect(useUiStore.getState().fontSize).toBe(20)
    await user.click(screen.getByRole('button', { name: '기본값' }))
    expect(useUiStore.getState().fontSize).toBe(13)
    expect(input).toHaveValue(13)
    expect(screen.getByRole('button', { name: '기본값' })).toBeDisabled()
  })
})

describe('NotifySection', () => {
  it('AC-07 체크박스 2개를 바꾸면 agentNotify·showUsage 가 바로 바뀐다', async () => {
    const user = userEvent.setup()
    renderWithDeps(<NotifySection />, makeDeps())
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    const notify = screen.getByRole('checkbox', { name: NOTIFY_LABEL })
    const usage = screen.getByRole('checkbox', { name: USAGE_LABEL })
    expect(notify).toBeChecked()
    expect(usage).toBeChecked()
    await user.click(notify)
    expect(useUiStore.getState()).toMatchObject({ agentNotify: false, showUsage: true })
    await user.click(usage)
    expect(useUiStore.getState()).toMatchObject({ agentNotify: false, showUsage: false })
    await user.click(notify)
    expect(useUiStore.getState().agentNotify).toBe(true)
    expect(notify).toBeChecked()
    expect(usage).not.toBeChecked()
  })
})

describe('AgentCommandsSection', () => {
  it('AC-08 명령 입력란 4개가 LAUNCH_LABEL 이름으로 저장된 명령을 보인다', () => {
    useUiStore.setState({ agentCommands: { ...DEFAULT_AGENT_COMMANDS, codex: 'codex --full-auto {prompt}' } })
    renderAgents()
    expect(screen.getAllByRole('textbox')).toHaveLength(LAUNCH_KINDS.length)
    for (const kind of LAUNCH_KINDS) expect(field(kind)).toHaveValue(kind === 'codex' ? 'codex --full-auto {prompt}' : DEFAULT_AGENT_COMMANDS[kind])
  })

  it('AC-08 입력하면 그 칸의 명령을 바로 agentCommands 에 저장한다', async () => {
    const { user } = renderAgents()
    await user.clear(field('codex'))
    await user.type(field('codex'), 'codex --full-auto {{prompt}')
    expect(field('codex')).toHaveValue('codex --full-auto {prompt}')
    expect(stored()).toEqual({ ...DEFAULT_AGENT_COMMANDS, codex: 'codex --full-auto {prompt}' })
  })

  it('AC-08 이미 기본값이면 [{LAUNCH_LABEL} 기본값] 은 disabled — 직접 입력에는 버튼이 없다', () => {
    renderAgents()
    for (const kind of ['claude', 'codex', 'gemini'] as const) expect(resetButton(kind)).toBeDisabled()
    expect(screen.getAllByRole('button', { name: / 기본값$/ })).toHaveLength(3)
    expect(screen.queryByRole('button', { name: `${LAUNCH_LABEL.custom} 기본값` })).toBeNull()
  })

  it('AC-08 [{LAUNCH_LABEL} 기본값] 은 칸과 store 를 DEFAULT_AGENT_COMMANDS 로 바꾼다', async () => {
    const { user } = renderAgents()
    await user.clear(field('gemini'))
    await user.type(field('gemini'), 'gemini --yolo -i {{prompt}')
    expect(resetButton('gemini')).toBeEnabled()
    await user.click(resetButton('gemini'))
    expect(field('gemini')).toHaveValue(DEFAULT_AGENT_COMMANDS.gemini)
    expect(stored().gemini).toBe(DEFAULT_AGENT_COMMANDS.gemini)
    expect(resetButton('gemini')).toBeDisabled()
  })

  it('EC-12 {prompt} 를 따옴표로 감싸면 그 오류, {prompt} 가 없으면 안내, 빈 칸은 표시 없음 — 값은 항상 저장한다', async () => {
    const { user } = renderAgents()
    const input = field('claude')
    // 따옴표로 감쌈 → 실행 대화상자와 같은 오류(role=alert)
    await user.clear(input)
    await user.type(input, 'claude "{{prompt}"')
    expect(screen.getByRole('alert')).toHaveTextContent(QUOTED_ERROR)
    expect(stored().claude).toBe('claude "{prompt}"')
    // {prompt} 없음 → 오류가 아닌 안내
    await user.clear(input)
    await user.type(input, 'claude --continue')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(NO_PROMPT_HINT)).toBeInTheDocument()
    expect(stored().claude).toBe('claude --continue')
    // 빈 칸 → 아무 표시도 없다
    await user.clear(input)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(NO_PROMPT_HINT)).toBeNull()
  })

  it('EC-13 칸 안의 공백은 그대로 두고(단어 사이 띄어쓰기 가능), 저장 값만 앞뒤를 trim 한다', async () => {
    const { user } = renderAgents()
    await user.clear(field('claude'))
    await user.type(field('claude'), '  claude ')
    expect(field('claude')).toHaveValue('  claude ')
    expect(stored().claude).toBe('claude')
    await user.type(field('claude'), '--verbose {{prompt}  ')
    expect(field('claude')).toHaveValue('  claude --verbose {prompt}  ')
    expect(stored().claude).toBe('claude --verbose {prompt}')
  })

  it('EC-23 칸을 비우면 빈 값을 저장한다', async () => {
    const { user } = renderAgents()
    await user.clear(field('codex'))
    expect(field('codex')).toHaveValue('')
    expect(stored().codex).toBe('')
  })

  it('EC-24 열린 동안 agentCommands 가 밖에서 바뀌면 손대지 않은 칸을 새 값으로 바꾸고, 손대지 않은 칸은 store 에 쓰지 않는다', async () => {
    const initial = stored()
    const { user } = renderAgents()
    expect(field('codex')).toHaveValue(DEFAULT_AGENT_COMMANDS.codex)
    // 띄우기만 해서는 store 에 쓰지 않는다
    expect(stored()).toBe(initial)
    // 입력 중인 칸 — 끝 공백은 저장 값(trim)과 같은 뜻이라 밖의 변경에도 그대로 남는다
    await user.clear(field('claude'))
    await user.type(field('claude'), 'claude --verbose {{prompt} ')
    // 호스트 공유·다른 창에서 온 변경
    const external = { ...stored(), codex: 'codex -x {prompt}' }
    act(() => useUiStore.setState({ agentCommands: external }))
    expect(field('codex')).toHaveValue('codex -x {prompt}')
    expect(field('claude')).toHaveValue('claude --verbose {prompt} ')
    expect(stored()).toBe(external)
    expect(external).toEqual({ ...DEFAULT_AGENT_COMMANDS, claude: 'claude --verbose {prompt}', codex: 'codex -x {prompt}' })
  })
})
