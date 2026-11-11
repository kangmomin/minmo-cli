// 터미널 (F-04, AC-08): worktree 경로를 cwd 로 하는 PTY + xterm 렌더.
// 이슈를 전환해도 세션이 유지되도록 열린 이슈마다 세션을 만들어 두고 선택된 것만 보여 준다.
// 이슈 안에서는 패널을 나눌 수 있고(Ctrl+D / Ctrl+Shift+D), 패널마다 PTY 하나를 가진다(Ctrl+W 로 닫으면 프로세스 트리 종료).
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useId, useRef, useState } from 'react'

import { useBaseDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { remotePty } from '../../lib/sshHost'
import { terminalBackground } from '../../lib/theme'
import { useUiStore } from '../../store/ui'
import { PANE_KEYS, TERMINAL_EXIT_HINT, createTerminalKeyHandler } from './keys'
import { layoutPanes, leafIds } from './panes'

/** remote 가 있으면 그 호스트(SSH 프로필)의 cwd 에서 터미널을 연다 */
export type TerminalSessionSpec = { issueId: string; cwd: string; remote?: { host: string; tmux: boolean } }

/** 원격 tmux 세션 선택: 이슈의 첫 패널이 기본 세션(앱을 꺼도 유지), 나머지는 패널과 함께 사라지는 세션 */
function paneRole(issueId: string, paneId: string) {
  const first = leafIds(useUiStore.getState().panes[issueId]?.tree ?? null)[0]
  return { primary: first === undefined || first === paneId, seq: Number(paneId.slice(paneId.lastIndexOf('::') + 2)) || 1 }
}

/** ptySpawn 응답 전에 도착한 pty-data 를 id 별로 보관하는 상한(문자 수) */
export const MAX_PENDING_PTY_CHARS = 256 * 1024

export interface TerminalTabProps {
  /** 세션을 유지할 이슈들(worktree 준비 완료) */
  sessions: TerminalSessionSpec[]
  activeId: string | null
  /** 터미널 탭이 선택되어 있는가 */
  visible: boolean
  /** Ctrl+Shift+M — 터미널 밖(탭 목록)으로 포커스를 옮긴다 */
  onExit?: () => void
}

export function TerminalTab({ sessions, activeId, visible, onExit }: TerminalTabProps) {
  const activeHasSession = sessions.some((s) => s.issueId === activeId)
  const hintId = useId()
  // PTY 는 터미널 탭에서 처음 볼 때 만들고, 이후에는 이슈를 전환해도 유지한다
  const [started, setStarted] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (visible && activeId && activeHasSession && !started.has(activeId)) setStarted((s) => new Set(s).add(activeId))
  }, [visible, activeId, activeHasSession, started])

  // 세션이 사라지면(worktree 삭제 등) started 에서도 뺀다 — 다시 나타나도 탭을 볼 때까지 PTY 를 만들지 않도록
  const sessionIds = sessions.map((s) => s.issueId).join('\n')
  useEffect(() => {
    const present = new Set(sessionIds.split('\n'))
    setStarted((s) => {
      const next = new Set([...s].filter((id) => present.has(id)))
      return next.size === s.size ? s : next
    })
  }, [sessionIds])

  const theme = useUiStore((s) => s.theme)

  // region 이름은 짧게 두고 탈출 안내는 보이는 한 줄 + aria-describedby 로 연결한다 — 이름·설명 중복 낭독 방지(AX-18)
  return (
    <div
      className={visible ? 'absolute inset-0 flex flex-col' : 'hidden'}
      style={{ background: terminalBackground(theme) }}
      data-testid="terminal-tab"
      role="region"
      aria-label="터미널"
      aria-describedby={activeHasSession ? hintId : undefined}
    >
      {activeHasSession && (
        <div className="flex shrink-0 flex-wrap gap-x-4 px-3 pt-1.5 text-xs text-neutral-400">
          <p id={hintId}>{TERMINAL_EXIT_HINT}: 터미널 밖으로 이동</p>
          <p>
            {PANE_KEYS.splitRight}: 오른쪽 분할 · {PANE_KEYS.splitDown}: 아래 분할 · {PANE_KEYS.close}: 패널 닫기
          </p>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {sessions.filter((s) => started.has(s.issueId)).map((s) => (
          <IssuePanes key={`${s.issueId}|${s.cwd}`} spec={s} active={visible && s.issueId === activeId} hintId={hintId} onExit={onExit} />
        ))}
        {visible && !activeHasSession && (
          <p className="p-4 text-sm text-neutral-400">worktree 가 준비되면 터미널을 사용할 수 있습니다.</p>
        )}
      </div>
    </div>
  )
}

/** 이슈 하나의 패널들. 트리 대신 평면 목록으로 배치해 분할·닫기 때 다른 패널이 다시 마운트되지 않게 한다 */
function IssuePanes({ spec, active, hintId, onExit }: { spec: TerminalSessionSpec; active: boolean; hintId: string; onExit?: () => void }) {
  const panes = useUiStore((s) => s.panes[spec.issueId])
  const ensurePanes = useUiStore((s) => s.ensurePanes)
  const newPane = useUiStore((s) => s.newPane)
  // panes 가 사라지면(worktree 기록 삭제 등) 마운트된 채로도 다시 만든다 — 빈 화면에 갇히지 않게
  useEffect(() => {
    if (!panes) ensurePanes(spec.issueId)
  }, [ensurePanes, panes, spec.issueId])
  if (!panes) return null
  const rects = layoutPanes(panes.tree)
  const multiple = rects.length > 1
  return (
    <div className={active ? 'absolute inset-0' : 'hidden'}>
      {rects.map((r) => (
        <div
          key={r.id}
          className={`absolute ${multiple && panes.focused === r.id ? 'outline outline-1 -outline-offset-1 outline-ring' : ''}`}
          style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
          data-testid="terminal-pane"
        >
          <TerminalSession spec={spec} paneId={r.id} active={active} hintId={hintId} onExit={onExit} />
        </div>
      ))}
      {!panes.tree && active && (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-neutral-400">
          <p>터미널 패널을 모두 닫았습니다</p>
          <Button size="sm" variant="secondary" onClick={() => newPane(spec.issueId)}>
            새 터미널
          </Button>
        </div>
      )}
    </div>
  )
}

type TermState = {
  t: Terminal
  fit: FitAddon
  ptyId: string | null
  ended: boolean
  end(): void
  /** 이 xterm 이 처리한 마지막 포커스 요청 — 인스턴스마다 둬야 StrictMode 재마운트로 새로 만든 xterm 도 포커스를 받는다 */
  focusToken?: number
}

function TerminalSession({
  spec,
  paneId,
  active,
  hintId,
  onExit,
}: {
  spec: TerminalSessionSpec
  paneId: string
  active: boolean
  hintId: string
  onExit?: () => void
}) {
  // PTY 입출력은 원격 터미널도 이 PC 의 ssh 프로세스를 거친다 — 화면의 호스트가 바뀌어도 세션을 다시 만들지 않게 고정한다
  const { tauri } = useBaseDeps()
  // 객체가 아니라 값으로 비교해야 세션 목록이 다시 만들어질 때 터미널을 새로 띄우지 않는다
  const remoteHost = spec.remote?.host
  const remoteTmux = spec.remote?.tmux ?? false
  const theme = useUiStore((s) => s.theme)
  const focusRequest = useUiStore((s) => s.focusRequest)
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<TermState | null>(null)
  const [error, setError] = useState<string | null>(null)
  // PTY 가 이미 종료돼 write 가 reject 되면 true — [다시 시작] 으로 gen 을 올려 xterm·PTY 를 새로 만든다(CR-08).
  // resize reject 는 살아 있는 PTY 의 일시 오류일 수 있어 종료로 보지 않는다(CR-19)
  const [ended, setEnded] = useState(false)
  const [gen, setGen] = useState(0)
  const focusAfterRestart = useRef(false)
  const restartButton = useRef<HTMLButtonElement>(null)
  // 종료 시점에 포커스가 이 터미널 안에 있었는지 — 있었다면 [다시 시작] 으로 포커스를 옮긴다(AX-34)
  const focusRestartButton = useRef(false)
  // 키 핸들러는 마운트 때 1회 연결하므로 최신 onExit 를 ref 로 읽는다
  const onExitRef = useRef(onExit)
  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])

  // 세션 생성: 마운트 1회(다시 시작 시 gen 이 바뀌면 다시). 언마운트(이슈의 worktree 삭제 등) 시 PTY 종료
  useEffect(() => {
    const el = host.current
    if (!el) return
    let disposed = false
    const t = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: terminalBackground(useUiStore.getState().theme) },
      // 출력을 스크린 리더가 읽을 수 있는 접근성 트리로도 내보낸다
      screenReaderMode: true,
    })
    const ui = useUiStore.getState
    t.attachCustomKeyEventHandler(
      createTerminalKeyHandler(() => onExitRef.current?.(), {
        splitRight: () => ui().splitPane(spec.issueId, paneId, 'row'),
        splitDown: () => ui().splitPane(spec.issueId, paneId, 'col'),
        // 패널이 언마운트되면 아래 cleanup 이 PTY(와 그 자손 프로세스)를 종료한다
        close: () => ui().closePane(spec.issueId, paneId),
      }),
    )
    const fit = new FitAddon()
    t.loadAddon(fit)
    // xterm 입력 textarea 의 aria-label 은 open() 때 정해지므로 그 전에 한국어로 바꾼다(전역 설정, AX-39)
    Terminal.strings.promptLabel = '터미널 입력'
    t.open(el)
    // 입력 textarea 에도 탈출 안내를 연결한다 — region 에만 있으면 입력에 포커스를 둔 사용자는 듣지 못한다(AX-39)
    t.textarea?.setAttribute('aria-describedby', hintId)
    // 클릭·Tab 으로 들어온 패널을 "현재 패널" 로 표시한다(분할·닫기 대상)
    const onFocus = () => useUiStore.getState().focusPane(spec.issueId, paneId)
    t.textarea?.addEventListener('focus', onFocus)
    // [다시 시작] 버튼이 사라지며 포커스를 잃으므로, 사용자가 시작한 재시작에 한해 새 터미널로 포커스를 옮긴다(자동 포커스 금지 AX-02 의 예외)
    if (focusAfterRestart.current) {
      focusAfterRestart.current = false
      t.focus()
    }
    const state: TermState = {
      t,
      fit,
      ptyId: null,
      ended: false,
      end: () => {
        if (disposed || state.ended) return
        state.ended = true
        focusRestartButton.current = el.contains(document.activeElement)
        setEnded(true)
      },
    }
    term.current = state
    const cleanups: (() => void)[] = []

    void (async () => {
      // spawn 응답(id 확정) 전에 온 출력은 첫 프롬프트일 수 있어 id 별로 보관했다가 확정 후 flush 한다(CR-07)
      const pending = new Map<string, string>()
      let settled = false
      try {
        const unlisten = await tauri.onPtyData((e) => {
          if (disposed) return
          if (e.id === state.ptyId) {
            t.write(e.data)
            return
          }
          // 확정 후(또는 spawn 실패 후)의 다른 id 는 다른 세션 출력 — 버린다
          if (settled) return
          const prev = pending.get(e.id) ?? ''
          if (prev.length < MAX_PENDING_PTY_CHARS) pending.set(e.id, (prev + e.data).slice(0, MAX_PENDING_PTY_CHARS))
        })
        // 구독이 끝나기 전에 언마운트됐으면 cleanup 이 이미 돌았다 → 여기서 바로 해제(CR-01)
        if (disposed) {
          unlisten()
          return
        }
        cleanups.push(unlisten)
        try {
          fit.fit()
        } catch {
          // 숨김 상태에서는 크기를 잴 수 없다 — 표시될 때 다시 맞춘다
        }
        const remote = remoteHost === undefined ? undefined : remotePty(remoteHost, remoteTmux, spec.cwd, paneRole(spec.issueId, paneId))
        const id = await tauri.ptySpawn({ cwd: spec.cwd, cols: Math.max(t.cols, 20), rows: Math.max(t.rows, 5), remote })
        settled = true
        if (disposed) {
          pending.clear()
          tauri.ptyKill(id).catch(() => undefined)
          return
        }
        state.ptyId = id
        const early = pending.get(id)
        pending.clear()
        if (early) t.write(early)
        useUiStore.setState((s) => ({ terminalIds: { ...s.terminalIds, [paneId]: id } }))
        const sub = t.onData((d) => {
          if (state.ended) return
          tauri.ptyWrite(id, d).catch(state.end)
        })
        cleanups.push(() => sub.dispose())
      } catch (e) {
        settled = true
        pending.clear()
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      disposed = true
      t.textarea?.removeEventListener('focus', onFocus)
      for (const c of cleanups) c()
      // kill 의 reject(이미 종료된 PTY 등)는 무시한다
      if (state.ptyId) tauri.ptyKill(state.ptyId).catch(() => undefined)
      useUiStore.setState((s) => {
        const terminalIds = { ...s.terminalIds }
        delete terminalIds[paneId]
        return { terminalIds }
      })
      t.dispose()
      term.current = null
    }
  }, [tauri, spec.cwd, spec.issueId, remoteHost, remoteTmux, paneId, hintId, gen])

  // 분할·닫기·[새 터미널] 처럼 사용자가 패널을 바꿨을 때만 대상 패널로 포커스를 옮긴다(AX-02 자동 포커스 금지 유지)
  useEffect(() => {
    const cur = term.current
    if (!cur || !focusRequest || focusRequest.paneId !== paneId || cur.focusToken === focusRequest.token) return
    cur.focusToken = focusRequest.token
    cur.t.focus()
    // 처리한 요청은 지운다 — 같은 패널 번호가 나중에 다시 마운트될 때 묵은 요청으로 포커스를 뺏지 않게(AX-02).
    // StrictMode 는 같은 커밋에서 effect 를 다시 돌리므로 그 뒤(다음 tick)에 지운다
    const token = focusRequest.token
    setTimeout(() => {
      if (useUiStore.getState().focusRequest?.token === token) useUiStore.setState({ focusRequest: null })
    }, 0)
  }, [focusRequest, paneId, gen])

  // 테마 전환을 열린 터미널에도 반영
  useEffect(() => {
    const cur = term.current
    if (cur) cur.t.options.theme = { background: terminalBackground(theme) }
  }, [theme])

  // 사용자가 이 터미널을 쓰던 중 세션이 끝났을 때만 포커스를 옮긴다 — 다른 탭·이슈에 포커스가 있으면 자동 포커스 금지(AX-02) 유지
  useEffect(() => {
    if (!ended || !focusRestartButton.current) return
    focusRestartButton.current = false
    restartButton.current?.focus()
  }, [ended])

  // 표시·리사이즈 시 크기 맞추고 PTY 에 전달. 포커스는 옮기지 않는다 — 탭·이슈 전환 시 포커스 강탈 금지(AX-02)
  useEffect(() => {
    const el = host.current
    if (!active || !el) return
    const resize = () => {
      const cur = term.current
      if (!cur) return
      try {
        cur.fit.fit()
      } catch {
        return
      }
      // reject 는 무시한다 — 종료 판정은 write reject 만(CR-19)
      if (cur.ptyId && !cur.ended) tauri.ptyResize(cur.ptyId, cur.t.cols, cur.t.rows).catch(() => undefined)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    return () => ro.disconnect()
  }, [active, tauri, gen])

  const restart = () => {
    focusAfterRestart.current = true
    setEnded(false)
    setError(null)
    setGen((g) => g + 1)
  }

  // 안내·버튼은 xterm host 보다 앞에 둔다 — host 는 Tab 을 셸로 보내므로 뒤에 있으면 키보드로 닿기 어렵다(AX-34).
  // role=alert 는 문구에만 두고 버튼은 형제로 분리한다(AX-35)
  return (
    <div className={active ? 'absolute inset-0 p-1.5' : 'hidden'}>
      {error && (
        <div className="flex items-center gap-3 p-2 text-sm text-red-400">
          <p role="alert" className="flex-1">
            터미널을 시작할 수 없습니다: {error}
          </p>
          <Button size="sm" variant="secondary" onClick={restart}>
            다시 시도
          </Button>
        </div>
      )}
      {ended && (
        <div className="absolute inset-x-2 bottom-2 z-10 flex items-center gap-3 rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-100">
          <p role="alert" className="flex-1">
            터미널 세션이 종료되었습니다
          </p>
          <Button ref={restartButton} size="sm" variant="secondary" onClick={restart}>
            다시 시작
          </Button>
        </div>
      )}
      <div key={gen} ref={host} className="size-full" />
    </div>
  )
}
