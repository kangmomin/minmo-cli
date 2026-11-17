// 하단 바의 AI 별 사용량 — 표시 글, 숨김 규칙, 호스트별 값, 설정
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { HostScope } from '../../app/host'
import type { AgentUsage, CodexUsage, SshProbe, UsageTokens } from '../../lib/tauri'
import { useHostsStore } from '../../store/hosts'
import { useServerStore } from '../../store/server'
import { useUiStore } from '../../store/ui'
import { createFakeTauri, ok } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { ServerSettingsDialog } from '../server/ServerSettingsDialog'
import { effectivePercent, formatTokens, limitsDetail, tokensDetail, totalTokens, windowLabel } from './format'
import { UsageBar, usageItems } from './UsageBar'
import { startOfToday } from './useAgentUsage'

const PROBE: SshProbe = { platform: 'linux', home: '/home/dev', git: 'git version 2.43.0', tmux: true }
const tok = (input: number, output: number, cacheWrite = 0, cacheRead = 0): UsageTokens => ({ input, output, cacheWrite, cacheRead })
const NONE: AgentUsage = { claude: null, codex: null, gemini: null }
const NOW = Date.parse('2026-11-17T12:00:00Z')
const codex = (limits: CodexUsage['limits'], tokens = tok(0, 0)): CodexUsage => ({ tokens, limits, limitsAtMs: NOW - 60_000 })

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState({ showUsage: true })
  useHostsStore.setState({ aliases: [], selected: null, probes: {}, connecting: null, error: null })
})

describe('표시 글', () => {
  it('formatTokens: 1000 미만은 그대로, 그 위는 k·M·B', () => {
    expect([0, 999, 1000, 1234, 12_345, 123_456, 999_499, 999_500, 1_234_567, 80_000_000, 1_500_000_000].map(formatTokens)).toEqual([
      '0', '999', '1k', '1.2k', '12.3k', '123k', '999k', '1M', '1.2M', '80M', '1.5B',
    ])
  })

  it('windowLabel: 5시간·주, 그 밖은 일·시간·분', () => {
    expect([300, 10080, 1440, 4320, 60, 90, 0].map(windowLabel)).toEqual(['5h', '주', '1일', '3일', '1h', '90분', '한도'])
  })

  it('합계에는 캐시에서 읽은 입력을 넣지 않고, 상세에 따로 보인다', () => {
    const t = tok(10, 20, 30, 1000)
    expect(totalTokens(t)).toBe(60)
    const detail = tokensDetail('Claude Code', t)
    expect(detail).toContain('오늘 60 토큰')
    expect(detail).toContain('캐시에서 읽은 입력 1,000 (합계에 넣지 않음)')
  })

  it('초기화 시각이 지난 한도는 0% 로 본다 · 상세에 기준 시각을 알린다', () => {
    const past = { usedPercent: 91.6, windowMinutes: 300, resetsAtMs: NOW - 1 }
    const future = { usedPercent: 91.6, windowMinutes: 300, resetsAtMs: NOW + 1 }
    expect(effectivePercent(past, NOW)).toBe(0)
    expect(effectivePercent(future, NOW)).toBe(92)
    expect(effectivePercent({ ...future, resetsAtMs: 0 }, NOW)).toBe(92)
    const detail = limitsDetail('Codex', codex([past, { usedPercent: 12, windowMinutes: 10080, resetsAtMs: NOW + 86_400_000 }]), NOW)
    expect(detail).toContain('Codex 5h 한도 0% · 초기화됨')
    expect(detail).toMatch(/Codex 주 한도 12% · .+ 초기화/)
    expect(detail).toContain('마지막으로 쓴 시점의 값')
  })

  it('usageItems: 한도를 아는 도구는 %, 모르는 도구는 오늘 토큰 수 — 쓰지 않은 도구는 뺀다', () => {
    const items = usageItems(
      { claude: tok(200_000, 40_000, 960_000, 30_000_000), codex: codex([{ usedPercent: 34, windowMinutes: 300, resetsAtMs: 0 }, { usedPercent: 12, windowMinutes: 10080, resetsAtMs: 0 }], tok(5, 5)), gemini: tok(0, 0) },
      NOW,
    )
    expect(items.map((i) => i.text)).toEqual(['Claude 1.2M 오늘', 'Codex 5h 34% 주 12%'])
    // 한도 기록이 없으면 토큰 수로 대신하고, 아무것도 없으면 뺀다
    expect(usageItems({ ...NONE, codex: codex([], tok(1000, 500)) }, NOW).map((i) => i.text)).toEqual(['Codex 1.5k 오늘'])
    expect(usageItems({ ...NONE, codex: codex([]) }, NOW)).toEqual([])
    expect(usageItems(NONE, NOW)).toEqual([])
  })

  it('한도가 높으면 색과 함께 글자로도 알린다', () => {
    const at = (p: number) => usageItems({ ...NONE, codex: codex([{ usedPercent: p, windowMinutes: 300, resetsAtMs: 0 }]) }, NOW)[0]
    expect(at(79)).toMatchObject({ text: 'Codex 5h 79%', level: 'ok' })
    expect(at(80)).toMatchObject({ text: 'Codex 5h 80% 높음', level: 'high' })
    expect(at(100)).toMatchObject({ text: 'Codex 5h 100% 한도 도달', level: 'full' })
  })

  it('startOfToday: 이 화면의 자정', () => {
    const d = new Date(2026, 10, 17, 15, 30, 12)
    expect(new Date(startOfToday(d))).toEqual(new Date(2026, 10, 17))
  })
})

describe('UsageBar', () => {
  it('이 PC 의 값을 한 줄로 보이고, 오늘 자정을 기준으로 읽는다', async () => {
    const { tauri } = createFakeTauri({ agentUsage: async () => ({ ...NONE, claude: tok(1000, 234), gemini: tok(80_000, 0) }) })
    renderWithDeps(<UsageBar />, makeDeps({ tauri }))
    // 바는 읽기 전부터 있다 — 값은 읽은 뒤에 채워진다
    expect(await screen.findByTestId('usage-claude')).toHaveTextContent('Claude 1.2k 오늘')
    expect(screen.getByTestId('usage-bar')).toHaveAccessibleName('AI 사용량 — 이 PC')
    expect(screen.getByTestId('usage-host')).toHaveTextContent('이 PC')
    expect(screen.queryByTestId('usage-empty')).not.toBeInTheDocument()
    expect(screen.getByTestId('usage-gemini')).toHaveTextContent('Gemini 80k 오늘')
    expect(screen.queryByTestId('usage-codex')).not.toBeInTheDocument()
    // 상세는 마우스(title)와 스크린 리더(aria-label) 모두에 있다
    expect(screen.getByTestId('usage-claude')).toHaveAttribute('title', expect.stringContaining('Claude Code — 오늘 1,234 토큰'))
    expect(screen.getByTestId('usage-claude')).toHaveAccessibleName(expect.stringContaining('입력 1,000 · 출력 234'))
    expect(tauri.agentUsage).toHaveBeenCalledWith(startOfToday())
  })

  it('보일 것이 없어도 바는 같은 높이로 남고(터미널 크기가 흔들리지 않게) 기록이 없다고 알린다', async () => {
    const { tauri } = createFakeTauri({ agentUsage: async () => ({ ...NONE, claude: tok(0, 0) }) })
    renderWithDeps(<UsageBar />, makeDeps({ tauri }))
    // 읽기 전에도 바는 있다
    expect(screen.getByTestId('usage-bar')).toBeInTheDocument()
    expect(screen.queryByTestId('usage-empty')).not.toBeInTheDocument()
    expect(await screen.findByTestId('usage-empty')).toHaveTextContent('오늘 AI 사용 기록 없음')
    expect(tauri.agentUsage).toHaveBeenCalled()
  })

  it('원격 호스트에서는 그 호스트의 기록을 ssh 로 읽는다 — 이 PC 의 값은 읽지 않는다', async () => {
    useHostsStore.setState({ probes: { srv: PROBE } })
    const remote = JSON.stringify({ claude: tok(1, 4999), codex: null, gemini: null })
    const { tauri } = createFakeTauri({ sshExec: async () => ok(remote), agentUsage: async () => ({ ...NONE, claude: tok(1, 1) }) })
    renderWithDeps(
      <HostScope alias="srv">
        <UsageBar />
      </HostScope>,
      makeDeps({ tauri }),
    )
    expect(await screen.findByTestId('usage-claude')).toHaveTextContent('Claude 5k 오늘')
    expect(screen.getByTestId('usage-host')).toHaveTextContent('srv')
    const [alias, argv, opts] = tauri.sshExec.mock.calls[0]
    expect(alias).toBe('srv')
    expect(argv).toEqual(['sh', '-s', '--', String(startOfToday())])
    expect(opts?.stdin).toContain('MINMO_USAGE_PY')
    expect(tauri.agentUsage).not.toHaveBeenCalled()
  })

  it('연결을 확인하지 못한 원격 호스트의 영역은 이 PC 로 동작한다 — ssh 를 부르지 않고 이 PC 라고 보인다', async () => {
    const { tauri } = createFakeTauri({ agentUsage: async () => ({ ...NONE, claude: tok(1000, 0) }) })
    renderWithDeps(
      <HostScope alias="srv">
        <UsageBar />
      </HostScope>,
      makeDeps({ tauri }),
    )
    expect(await screen.findByTestId('usage-host')).toHaveTextContent('이 PC')
    expect(tauri.sshExec).not.toHaveBeenCalled()
  })

  it('원격에 python3 이 없으면 그 사실을 알린다', async () => {
    useHostsStore.setState({ probes: { srv: PROBE } })
    const { tauri } = createFakeTauri({ sshExec: async () => ok('{"unavailable":"python3"}\n') })
    renderWithDeps(
      <HostScope alias="srv">
        <UsageBar />
      </HostScope>,
      makeDeps({ tauri }),
    )
    expect(await screen.findByTestId('usage-unavailable')).toHaveTextContent('python3 필요')
  })

  it('설정에서 끄면 읽지도 보이지도 않는다 — 이 PC 에 저장한다', async () => {
    const { tauri } = createFakeTauri({ agentUsage: async () => ({ ...NONE, claude: tok(1000, 0) }) })
    const user = userEvent.setup()
    useServerStore.setState({ settingsOpen: true })
    renderWithDeps(
      <>
        <UsageBar />
        <ServerSettingsDialog tauri={tauri} />
      </>,
      makeDeps({ tauri }),
    )
    await screen.findByTestId('usage-bar')
    const box = await screen.findByRole('checkbox', { name: '하단 바에 AI 별 사용량 표시' })
    expect(box).toBeChecked()
    await user.click(box)
    expect(screen.queryByTestId('usage-bar')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('minmo-ui')!).state.showUsage).toBe(false)
    useServerStore.setState({ settingsOpen: false })
  })
})
