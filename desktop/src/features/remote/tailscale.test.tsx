// Tailscale 도우미 — 상태별 화면(설치 → 로그인 → 연결됨 → HTTPS), 설치 출력, 접속 주소·QR 에 HTTPS 주소 반영
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { RemoteStatus, TailscaleLogEvent, TailscaleStatus } from '../../lib/tauri'
import { TAILSCALE_MISSING, createFakeTauri, deferred } from '../../test/fakes'
import { makeDeps, renderWithDeps } from '../../test/render'
import { RemoteAccessDialog, shareableAddress, withHttps } from './RemoteAccessDialog'
import { TailscaleSection, appendLog } from './TailscaleSection'

const NEEDS_LOGIN: TailscaleStatus = { ...TAILSCALE_MISSING, state: 'needs-login', install: null }
const RUNNING: TailscaleStatus = { ...NEEDS_LOGIN, state: 'running', name: 'my-pc.tail1234.ts.net', ips: ['100.64.0.1'] }
const HTTPS = 'https://my-pc.tail1234.ts.net'

function renderSection(overrides: Parameters<typeof createFakeTauri>[0], props: Partial<Parameters<typeof TailscaleSection>[0]> = {}) {
  const fake = createFakeTauri(overrides)
  const onStatus = vi.fn()
  renderWithDeps(<TailscaleSection remoteEnabled onStatus={onStatus} pollMs={20} {...props} />, makeDeps({ tauri: fake.tauri }))
  return { fake, onStatus, user: userEvent.setup() }
}

describe('TailscaleSection', () => {
  it('설치 안 됨: 실행될 명령을 먼저 보여 주고, [Tailscale 설치] 를 눌러야 설치한다 — 출력이 보이고 끝나면 로그인 단계로 간다', async () => {
    let state = TAILSCALE_MISSING
    let emit: (e: TailscaleLogEvent) => void = () => {}
    const done = deferred<{ exitCode: number | null; cancelled: boolean }>()
    const { fake, user } = renderSection({
      tailscaleStatus: async () => state,
      tailscaleInstall: () => done.promise,
      onTailscaleLog: async (cb) => {
        emit = cb
        return () => {}
      },
    })
    expect(await screen.findByText('winget install --id Tailscale.Tailscale -e')).toBeInTheDocument()
    expect(screen.getByText(/누르면 이 명령을 실행합니다/)).toBeInTheDocument()
    // 누르기 전에는 설치하지 않는다
    expect(fake.tauri.tailscaleInstall).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Tailscale 설치/ }))
    expect(fake.tauri.tailscaleInstall).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('설치하는 중…')).toBeInTheDocument()
    emit({ line: 'Found Tailscale [Tailscale.Tailscale]', transient: false })
    emit({ line: '██▒▒ 10%', transient: true })
    emit({ line: '████ 100%', transient: true })
    await waitFor(() => expect(screen.getByTestId('tailscale-log')).toHaveTextContent('Found Tailscale [Tailscale.Tailscale] ████ 100%'))
    expect(screen.getByTestId('tailscale-log')).not.toHaveTextContent('10%')
    await user.click(screen.getByRole('button', { name: '취소' }))
    expect(fake.tauri.tailscaleInstallCancel).toHaveBeenCalled()

    state = NEEDS_LOGIN
    done.resolve({ exitCode: 0, cancelled: false })
    expect(await screen.findByRole('button', { name: /Tailscale 로그인/ })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('설치가 실패하면 종료 코드를 알리고 설치 페이지로 갈 수 있다', async () => {
    const { fake, user } = renderSection({ tailscaleInstall: async () => ({ exitCode: 1603, cancelled: false }) })
    await user.click(await screen.findByRole('button', { name: /Tailscale 설치/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('종료 코드 1603')
    await user.click(screen.getByRole('button', { name: /설치 페이지 열기/ }))
    expect(fake.tauri.openUrl).toHaveBeenCalledWith('https://tailscale.com/download')
  })

  it('앱이 대신 설치할 수 없는 OS 에서는 명령만 안내하고 설치 버튼이 없다', async () => {
    renderSection({ tailscaleStatus: async () => ({ ...TAILSCALE_MISSING, install: { command: 'curl -fsSL https://tailscale.com/install.sh | sh', auto: false, downloadUrl: 'https://tailscale.com/download' } }) })
    expect(await screen.findByText('curl -fsSL https://tailscale.com/install.sh | sh')).toBeInTheDocument()
    expect(screen.getByText(/앱이 대신 실행하지 않습니다/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Tailscale 설치/ })).toBeNull()
    expect(screen.getByRole('button', { name: /설치 페이지 열기/ })).toBeInTheDocument()
  })

  it('로그인: 로그인 주소를 브라우저로 열고, 로그인이 끝나면(상태가 바뀌면) 스스로 연결됨으로 넘어간다', async () => {
    let state = NEEDS_LOGIN
    const { fake, onStatus, user } = renderSection({
      tailscaleStatus: async () => state,
      tailscaleLogin: async () => ({ url: 'https://login.tailscale.com/a/abc' }),
    })
    await user.click(await screen.findByRole('button', { name: /Tailscale 로그인/ }))
    expect(fake.tauri.openUrl).toHaveBeenCalledWith('https://login.tailscale.com/a/abc')
    expect(await screen.findByTestId('tailscale-login-url')).toHaveTextContent('https://login.tailscale.com/a/abc')
    // 브라우저에서 로그인이 끝났다
    state = RUNNING
    expect(await screen.findByText('연결됨')).toBeInTheDocument()
    expect(screen.getByText('my-pc.tail1234.ts.net')).toBeInTheDocument()
    expect(screen.queryByTestId('tailscale-login-url')).toBeNull()
    expect(onStatus).toHaveBeenLastCalledWith(RUNNING)
  })

  it('꺼져 있으면 [Tailscale 연결], 관리자 승인을 기다리면 버튼 없이 안내만, 서비스가 답하지 않으면 그 사유를 보인다', async () => {
    const first = renderSection({ tailscaleStatus: async () => ({ ...NEEDS_LOGIN, state: 'stopped' }) })
    expect(await screen.findByRole('button', { name: /Tailscale 연결/ })).toBeInTheDocument()
    first.fake.tauri.tailscaleStatus.mockResolvedValue({ ...NEEDS_LOGIN, state: 'needs-approval' })
    expect(await screen.findByText(/관리자가 이 기기를 승인해야 합니다/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Tailscale/ })).toBeNull()
    first.fake.tauri.tailscaleStatus.mockResolvedValue({ ...NEEDS_LOGIN, state: 'unavailable', error: 'failed to connect to local Tailscale service' })
    expect(await screen.findByText(/서비스가 응답하지 않습니다/)).toBeInTheDocument()
    expect(screen.getByText('failed to connect to local Tailscale service')).toBeInTheDocument()
  })

  it('HTTPS: [HTTPS 로 열기] 로 켜고 [HTTPS 끄기] 로 끈다', async () => {
    const { fake, user } = renderSection({
      tailscaleStatus: vi.fn(async () => RUNNING),
      tailscaleServe: async (on) => ({ status: { ...RUNNING, httpsUrl: on ? HTTPS : null }, enableUrl: null }),
    })
    fake.tauri.tailscaleServe.mockImplementation(async (on) => {
      const status = { ...RUNNING, httpsUrl: on ? HTTPS : null }
      fake.tauri.tailscaleStatus.mockResolvedValue(status)
      return { status, enableUrl: null }
    })
    await user.click(await screen.findByRole('button', { name: /HTTPS 로 열기/ }))
    expect(fake.tauri.tailscaleServe).toHaveBeenCalledWith(true)
    expect(await screen.findByText(HTTPS)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'HTTPS 끄기' }))
    expect(fake.tauri.tailscaleServe).toHaveBeenLastCalledWith(false)
    expect(await screen.findByRole('button', { name: /HTTPS 로 열기/ })).toBeInTheDocument()
  })

  it('tailnet 에서 HTTPS 가 꺼져 있으면 켜는 주소를 안내하고, 누를 때만 연다', async () => {
    const url = 'https://login.tailscale.com/f/serve?node=n1'
    const { fake, user } = renderSection({ tailscaleStatus: async () => RUNNING, tailscaleServe: async () => ({ status: RUNNING, enableUrl: url }) })
    await user.click(await screen.findByRole('button', { name: /HTTPS 로 열기/ }))
    expect(await screen.findByTestId('tailscale-enable')).toHaveTextContent(url)
    expect(fake.tauri.openUrl).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /설정 페이지 열기/ }))
    expect(fake.tauri.openUrl).toHaveBeenCalledWith(url)
  })

  it('443 에 다른 설정이 있거나 원격 접속이 꺼져 있으면 HTTPS 버튼이 없고, 실패는 사유를 보인다', async () => {
    const conflict = renderSection({ tailscaleStatus: async () => ({ ...RUNNING, httpsConflict: true }) })
    expect(await screen.findByText(/이미 다른 tailscale serve 설정이 있어/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /HTTPS/ })).toBeNull()
    conflict.fake.tauri.tailscaleStatus.mockResolvedValue(RUNNING)
    conflict.fake.tauri.tailscaleServe.mockRejectedValue(new Error('Access denied: serve config denied'))
    await conflict.user.click(await screen.findByRole('button', { name: /HTTPS 로 열기/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Access denied')
  })

  it('원격 접속이 꺼져 있으면 HTTPS 버튼 대신 안내를 보인다', async () => {
    renderSection({ tailscaleStatus: async () => RUNNING }, { remoteEnabled: false })
    expect(await screen.findByText(/원격 접속을 켜면 HTTPS 주소로도 열 수 있습니다/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /HTTPS/ })).toBeNull()
  })

  it('붙은 기기의 화면에서는 아무것도 보이지 않고 호스트에 묻지도 않는다', async () => {
    const { fake } = renderSection({ runtime: 'remote' })
    await new Promise((r) => setTimeout(r, 60))
    expect(screen.queryByText('Tailscale')).toBeNull()
    expect(fake.tauri.tailscaleStatus).not.toHaveBeenCalled()
  })

  it('진행 막대 줄은 앞의 진행 막대를 덮어쓰고, 출력은 마지막 200줄만 둔다', () => {
    const bar = (line: string) => ({ line, transient: true })
    const text = (line: string) => ({ line, transient: false })
    expect(appendLog([text('a'), bar('1')], bar('2'))).toEqual([text('a'), bar('2')])
    expect(appendLog([bar('1')], text('done'))).toEqual([bar('1'), text('done')])
    const many = Array.from({ length: 250 }, (_, i) => text(String(i))).reduce(appendLog, [] as TailscaleLogEvent[])
    expect(many).toHaveLength(200)
    expect(many[0].line).toBe('50')
  })
})

describe('RemoteAccessDialog 와 Tailscale', () => {
  it('HTTPS 주소가 있으면 접속 주소 맨 앞에 두고 QR 도 그 주소를 쓴다', () => {
    const local = { kind: 'local' as const, url: 'http://127.0.0.1:8790' }
    const ts = { kind: 'tailscale' as const, url: 'http://100.64.0.1:8790' }
    const all = withHttps([local, ts], HTTPS)
    expect(all[0]).toEqual({ kind: 'tailscale-https', url: HTTPS })
    expect(shareableAddress(all)?.url).toBe(HTTPS)
    expect(withHttps([local, ts], null)).toEqual([local, ts])
  })

  it('Tailscale 에 연결되면 접속 주소를 다시 읽고(설정은 바꾸지 않는다), HTTPS 주소를 기기 등록 QR 에 쓴다', async () => {
    const base: RemoteStatus = { enabled: true, lan: false, port: 8790, addresses: [{ kind: 'local', url: 'http://127.0.0.1:8790' }], devices: [], error: null }
    const withTs: RemoteStatus = { ...base, addresses: [...base.addresses, { kind: 'tailscale', url: 'http://100.64.0.1:8790' }] }
    const fake = createFakeTauri({ remoteStatus: async () => base, tailscaleStatus: async () => ({ ...RUNNING, httpsUrl: HTTPS }) })
    // 호스트가 Tailscale 주소에도 연 뒤의 목록
    fake.tauri.remoteStatus.mockResolvedValueOnce(base).mockResolvedValue(withTs)
    renderWithDeps(<RemoteAccessDialog open onOpenChange={() => {}} />, makeDeps({ tauri: fake.tauri }))
    const user = userEvent.setup()
    expect(await screen.findByText('http://100.64.0.1:8790')).toBeInTheDocument()
    expect(screen.getByText('Tailscale HTTPS')).toBeInTheDocument()
    // 입력하던 포트는 그대로다
    const port = screen.getByLabelText('포트')
    await user.clear(port)
    await user.type(port, '9001')
    await user.click(screen.getByRole('button', { name: /기기 등록/ }))
    expect(await screen.findByRole('img', { name: `접속 주소 QR 코드: ${HTTPS}` })).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 50))
    expect(port).toHaveValue('9001')
    expect(fake.tauri.remoteConfigure).not.toHaveBeenCalled()
    // 주소가 그대로면 다시 읽지 않는다(처음 + 연결됨을 알았을 때)
    expect(fake.tauri.remoteStatus).toHaveBeenCalledTimes(2)
  })

  it('버튼으로 한 일의 결과는 그 전에 떠난 상태 확인의 답에 덮이지 않고, 창을 다시 열어도 설치 중임을 안다', async () => {
    const slow = deferred<TailscaleStatus>()
    const fake = createFakeTauri({ tailscaleServe: async () => ({ status: { ...RUNNING, httpsUrl: HTTPS }, enableUrl: null }) })
    fake.tauri.tailscaleStatus.mockResolvedValueOnce(RUNNING).mockReturnValueOnce(slow.promise).mockResolvedValue({ ...RUNNING, httpsUrl: HTTPS })
    const view = renderWithDeps(<TailscaleSection remoteEnabled onStatus={() => {}} pollMs={5} />, makeDeps({ tauri: fake.tauri }))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /HTTPS 로 열기/ }))
    expect(await screen.findByText(HTTPS)).toBeInTheDocument()
    // 버튼을 누르기 전에 떠난 확인이 이제야 "HTTPS 없음"으로 답한다
    slow.resolve(RUNNING)
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByText(HTTPS)).toBeInTheDocument()
    view.unmount()

    const again = createFakeTauri({ tailscaleStatus: async () => ({ ...TAILSCALE_MISSING, installing: true }) })
    renderWithDeps(<TailscaleSection remoteEnabled onStatus={() => {}} pollMs={20} />, makeDeps({ tauri: again.tauri }))
    expect(await screen.findByText('설치하는 중…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Tailscale 설치/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: '취소' }))
    expect(again.tauri.tailscaleInstallCancel).toHaveBeenCalled()
  })

  it('Tailscale 이 없으면 원격 접속 설정을 건드리지 않고 설치 안내를 보인다', async () => {
    const fake = createFakeTauri()
    renderWithDeps(<RemoteAccessDialog open onOpenChange={() => {}} />, makeDeps({ tauri: fake.tauri }))
    expect(await screen.findByRole('button', { name: /Tailscale 설치/ })).toBeInTheDocument()
    expect(fake.tauri.remoteConfigure).not.toHaveBeenCalled()
  })
})
