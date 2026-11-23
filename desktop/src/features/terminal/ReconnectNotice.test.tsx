// 원격 터미널 재접속 안내(#89) — ① 다시 접속하는 중 · ② 다시 접속하지 못함 · ③ 다시 접속했음
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { PtyLink } from '../../lib/tauri'
import { ReconnectNotice } from './ReconnectNotice'

const link = (o: Partial<PtyLink> = {}): PtyLink => ({ phase: 'waiting', attempt: 1, max: 5, seq: 1, reason: null, at: null, ...o })
const WAITING = (n: number) => `연결이 끊겼습니다. 다시 접속하는 중… (${n}/5)`
const FAILED = '연결이 끊겼습니다. 다시 접속하지 못했습니다'
const STARTED = '연결이 끊겨 다시 접속하는 중입니다'

function view(props: { link: PtyLink | null; justConnectedAt?: string | null; onReconnect?: () => void }) {
  const onReconnect = props.onReconnect ?? vi.fn()
  const ui = (p: typeof props) => <ReconnectNotice link={p.link} justConnectedAt={p.justConnectedAt ?? null} onReconnect={onReconnect} />
  const r = render(ui(props))
  return { ...r, onReconnect, update: (p: typeof props) => r.rerender(ui(p)) }
}

describe('ReconnectNotice ① 다시 접속하는 중', () => {
  // AC-01 · AC-02
  it('끊기면 "다시 접속하는 중… (n/5)" 을 보이고, 시도가 늘면 n 이 바뀐다', () => {
    const v = view({ link: link({ phase: 'waiting', attempt: 1 }) })
    expect(v.container).toHaveTextContent(WAITING(1))
    v.update({ link: link({ phase: 'connecting', attempt: 1, seq: 2 }) })
    expect(v.container).toHaveTextContent(WAITING(1))
    v.update({ link: link({ phase: 'waiting', attempt: 2, seq: 3 }) })
    expect(v.container).toHaveTextContent(WAITING(2))
    expect(v.container).not.toHaveTextContent(WAITING(1))
  })

  // AC-08
  it('기다리는 중 [지금 재접속] 을 누르면 재접속을 요청한다', () => {
    const v = view({ link: link({ phase: 'waiting', attempt: 2 }) })
    fireEvent.click(screen.getByRole('button', { name: '지금 재접속' }))
    expect(v.onReconnect).toHaveBeenCalledTimes(1)
  })

  // AC-08 — 시도 중에는 누를 수 없다고 알리되(aria-disabled) 포커스는 그대로 둔다(disabled 를 쓰면 포커스를 잃는다)
  it('시도 중(connecting)에는 [지금 재접속] 이 aria-disabled 이고 눌러도 요청하지 않는다 — disabled 속성은 쓰지 않는다', () => {
    const v = view({ link: link({ phase: 'connecting', attempt: 2 }) })
    const button = screen.getByRole('button', { name: '지금 재접속' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toHaveAttribute('disabled')
    button.focus()
    fireEvent.click(button)
    expect(v.onReconnect).not.toHaveBeenCalled()
    expect(button).toHaveFocus()
  })

  // AC-01 · D-24 — 상시 있는 상태 알림 영역에 재접속 시작을 알린다. 시도 횟수가 바뀌어도 다시 읽히지 않게 문구는 그대로
  it('상시 role=status 영역: 연결됨이면 비어 있고, 재접속이 시작되면 시작 문구 — 시도 횟수가 바뀌어도 문구는 같다', () => {
    const v = view({ link: null })
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('')
    v.update({ link: link({ phase: 'waiting', attempt: 1 }) })
    expect(screen.getByRole('status')).toBe(status)
    expect(status.textContent?.trim()).toBe(STARTED)
    v.update({ link: link({ phase: 'connecting', attempt: 1, seq: 2 }) })
    v.update({ link: link({ phase: 'waiting', attempt: 2, seq: 3 }) })
    expect(status.textContent?.trim()).toBe(STARTED)
  })
})

describe('ReconnectNotice ② 다시 접속하지 못함', () => {
  // AC-07
  it('5번 모두 실패하면 alert 로 "다시 접속하지 못했습니다(5번)" 과 [재접속] — 누르면 재접속을 요청한다', () => {
    const v = view({ link: link({ phase: 'failed', attempt: 5 }) })
    expect(screen.getByRole('alert')).toHaveTextContent(`${FAILED}(5번)`)
    fireEvent.click(screen.getByRole('button', { name: '재접속' }))
    expect(v.onReconnect).toHaveBeenCalledTimes(1)
  })

  // EC-01 · EC-07 — 인증·호스트 키·호스트를 찾을 수 없음은 횟수 대신 원인을 보인다
  it.each([
    ['auth', '(인증 실패)'],
    ['host_key', '(호스트 키 확인 실패)'],
    ['spawn', '(접속할 수 없음)'],
  ] as const)('원인이 %s 이면 횟수 대신 %s', (reason, text) => {
    view({ link: link({ phase: 'failed', attempt: 1, reason }) })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(`${FAILED}${text}`)
    expect(alert).not.toHaveTextContent('번)')
  })

  // AX-35 — 버튼이 alert 안에 있으면 버튼 이름까지 읽힌다
  it('role=alert 는 문구에만 두고 [재접속] 은 형제로 둔다', () => {
    view({ link: link({ phase: 'failed', attempt: 5 }) })
    const alert = screen.getByRole('alert')
    const button = screen.getByRole('button', { name: '재접속' })
    expect(alert).not.toContainElement(button)
    expect(alert.parentElement).toBe(button.parentElement)
  })

  // AX-39 — 포커스가 [재접속] 으로 옮겨 온 뒤에도 실패 이유를 듣는다
  it('② 문구는 messageId 를 id 로 갖고, [재접속] 의 aria-describedby 가 그 문구를 가리킨다', () => {
    render(
      <ReconnectNotice link={link({ phase: 'failed', attempt: 5 })} justConnectedAt={null} onReconnect={vi.fn()} messageId="notice-1" />,
    )
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'notice-1')
    expect(screen.getByRole('button', { name: '재접속' })).toHaveAttribute('aria-describedby', 'notice-1')
  })

  // AC-07 — ①↔② 가 바뀌어도 같은 버튼 요소라 포커스가 유지된다
  it('[지금 재접속] 과 [재접속] 은 같은 버튼 요소다(문구만 바뀐다)', () => {
    const v = view({ link: link({ phase: 'connecting', attempt: 5 }) })
    const button = screen.getByRole('button', { name: '지금 재접속' })
    v.update({ link: link({ phase: 'failed', attempt: 5, seq: 2 }) })
    expect(screen.getByRole('button', { name: '재접속' })).toBe(button)
    v.update({ link: link({ phase: 'waiting', attempt: 1, seq: 3 }) })
    expect(screen.getByRole('button', { name: '지금 재접속' })).toBe(button)
  })
})

describe('ReconnectNotice ③ 다시 접속함', () => {
  // AC-03 · D-25
  it('다시 접속하면 "다시 접속했습니다 (HH:MM)" 를 보이고 상태 알림 영역에도 같은 문구', () => {
    view({ link: null, justConnectedAt: '14:02' })
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('다시 접속했습니다 (14:02)')
    const shown = screen.getAllByText((_, el) => el?.textContent?.trim() === '다시 접속했습니다 (14:02)' && !status.contains(el))
    expect(shown.length).toBeGreaterThan(0)
    expect(screen.queryByRole('button')).toBeNull()
  })

  // AC-03 — 연결됨이고 ③ 도 없으면 안내 줄이 사라진다
  it('연결됨(link=null)이고 방금 다시 접속한 것도 아니면 아무것도 보이지 않는다', () => {
    const v = view({ link: link({ phase: 'waiting', attempt: 1 }) })
    expect(screen.getByRole('button', { name: '지금 재접속' })).toBeInTheDocument()
    v.update({ link: null, justConnectedAt: null })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(v.container).not.toHaveTextContent('연결이 끊겼습니다')
    expect(v.container).not.toHaveTextContent('다시 접속했습니다')
  })
})
