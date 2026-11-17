// 터미널 (F-04, AC-08): worktree 경로를 cwd 로 하는 PTY + xterm 렌더.
// 이슈를 전환해도 세션이 유지되도록 열린 이슈마다 세션을 만들어 두고 선택된 것만 보여 준다.
// 이슈 안에서는 패널을 나눌 수 있고(Ctrl+D / Ctrl+Shift+D), 패널마다 PTY 하나를 가진다(Ctrl+W 로 닫으면 프로세스 트리 종료).
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'

import { useBaseDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { newOrigin } from '../../lib/sharedState'
import { remotePty } from '../../lib/sshHost'
import type { TauriApi, WindowsPty } from '../../lib/tauri'
import { terminalBackground, terminalTheme } from '../../lib/theme'
import { useUiStore } from '../../store/ui'
import { LAUNCH_DELAY_MS, looksLikeAuthPrompt, takeLaunch } from '../agents/launchQueue'
import { noteTerminalInput } from '../agents/useAgentTracker'
import { PaneAgentStrip } from '../agents/AgentBadge'
import { CLIPBOARD_KEYS, EDIT_KEYS, PANE_KEYS, TERMINAL_EXIT_HINT, createTerminalKeyHandler } from './keys'
import { TerminalKeyBar, registerTerminalInput, useNarrow, useTouch } from './TerminalKeyBar'
import { layoutPanes, leafIds } from './panes'
import { attachWebgl } from './webgl'

/** remote 가 있으면 그 호스트(SSH 프로필)의 cwd 에서 터미널을 연다 */
/** remote.tmux: 전용 tmux 세션으로 여는가(설정이 켜져 있고 원격에 tmux 가 있을 때) */
export type TerminalSessionSpec = { issueId: string; cwd: string; remote?: { host: string; tmux: boolean } }

/** 원격 tmux 세션 선택: 이슈의 첫 패널이 기본 세션(앱을 꺼도 유지), 나머지는 패널과 함께 사라지는 세션 */
function paneRole(issueId: string, paneId: string) {
  const first = leafIds(useUiStore.getState().panes[issueId]?.tree ?? null)[0]
  return { primary: first === undefined || first === paneId, seq: Number(paneId.slice(paneId.lastIndexOf('::') + 2)) || 1 }
}

/** 터미널 크기를 가져온 뒤 입력을 넣기까지 두는 틈 — 크기 변경과 입력이 겹치면 셸이 그 입력을 잃는다 */
const TAKE_OVER_SETTLE_MS = 250

/** 패널이 아직 화면 구성에 있는가 — 없어진 패널의 터미널만 끝낸다 */
function paneExists(issueId: string, paneId: string): boolean {
  return leafIds(useUiStore.getState().panes[issueId]?.tree ?? null).includes(paneId)
}

/** ptySpawn 응답 전에 도착한 pty-data 를 id 별로 보관하는 상한(문자 수) */
export const MAX_PENDING_PTY_CHARS = 256 * 1024

const windowsPtyCache = new WeakMap<TauriApi, Promise<WindowsPty | null>>()

/**
 * 터미널 호스트(이 PC)의 ConPTY 정보 — 바뀌지 않으므로 API 마다 한 번만 묻는다. 묻지 못하면 null(옵션 없이 그린다)이고,
 * 다음 터미널이 다시 묻는다(원격 화면이 잠시 끊긴 경우 등)
 */
function hostWindowsPty(tauri: TauriApi): Promise<WindowsPty | null> {
  let info = windowsPtyCache.get(tauri)
  if (!info) {
    info = tauri.ptyWindows().catch(() => {
      windowsPtyCache.delete(tauri)
      return null
    })
    windowsPtyCache.set(tauri, info)
  }
  return info
}

export interface TerminalTabProps {
  /** 세션을 유지할 이슈들(worktree 준비 완료) */
  sessions: TerminalSessionSpec[]
  activeId: string | null
  /** 터미널 탭이 선택되어 있는가 */
  visible: boolean
  /** Ctrl+Shift+M — 터미널 밖(탭 목록)으로 포커스를 옮긴다 */
  onExit?: () => void
}

/**
 * 지금 유지하는 세션들 — 세션이 목록에서 빠져(작업 폴더 삭제 등) 내려가는 터미널은 끝내고,
 * 터미널 탭 전체가 내려가는 경우(호스트 전환 등)에는 남겨 두기 위해 구분한다.
 */
type LiveSessions = { mounted: boolean; keys: Set<string> }
const LiveSessionsContext = createContext<{ current: LiveSessions }>({ current: { mounted: false, keys: new Set() } })
const sessionKey = (s: Pick<TerminalSessionSpec, 'issueId' | 'cwd'>) => `${s.issueId}|${s.cwd}`

export function TerminalTab({ sessions, activeId, visible, onExit }: TerminalTabProps) {
  const activeHasSession = sessions.some((s) => s.issueId === activeId)
  const live = useRef<LiveSessions>({ mounted: true, keys: new Set() })
  live.current.keys = new Set(sessions.map(sessionKey))
  // 내려갈 때는 부모의 정리가 자식보다 먼저 돈다 — 자식(터미널)이 "탭 전체가 내려가는 중"임을 알 수 있다
  useEffect(() => {
    const l = live.current
    l.mounted = true
    return () => {
      l.mounted = false
    }
  }, [])
  const hintId = useId()
  // PTY 는 사용자가 터미널을 열 때(Ctrl+T·[터미널 열기]·에이전트 실행) 만들고, 이후에는 이슈를 전환해도 유지한다.
  // 이슈를 고르기만 해서는 만들지 않는다 — 잘못 고른 이슈마다 셸이 뜨지 않게
  const started = useUiStore((s) => s.startedTerminals)
  const openTerminal = useUiStore((s) => s.openTerminal)
  // 브라우저로 붙은 화면에서는 Ctrl+T 를 브라우저(새 탭)가 가져간다 — 되지 않는 단축키는 안내하지 않는다
  const openKeyWorks = useBaseDeps().tauri.runtime !== 'remote'
  const activeStarted = activeId !== null && activeHasSession && activeId in started
  // 이미 떠 있는 터미널(다른 화면이 열었거나, 이 화면을 다시 불러온 경우)에는 열라고 하지 않아도 붙는다 — 새 프로세스를 만들지 않는다
  const activeAlive = useUiStore((s) => activeId !== null && leafIds(s.panes[activeId]?.tree ?? null).some((p) => p in s.terminalIds))
  useEffect(() => {
    if (visible && activeId && activeHasSession && !activeStarted && activeAlive) useUiStore.getState().markTerminalStarted(activeId)
  }, [visible, activeId, activeHasSession, activeStarted, activeAlive])

  // 세션이 사라지면(worktree 삭제 등) started 에서도 뺀다 — 다시 나타나도 사용자가 열 때까지 PTY 를 만들지 않도록
  const sessionIds = sessions.map((s) => s.issueId).join('\n')
  useEffect(() => {
    useUiStore.getState().pruneStartedTerminals(new Set(sessionIds.split('\n')))
  }, [sessionIds])

  const theme = useUiStore((s) => s.theme)
  // 화면 키보드를 쓰는 기기에는 Esc·Tab·방향키 줄을 둔다 — 지금 이슈의 포커스한(없으면 첫) 패널로 보낸다
  const touch = useTouch()
  const activePane = useUiStore((s) => {
    const p = activeId ? s.panes[activeId] : undefined
    return p ? (p.focused ?? leafIds(p.tree)[0] ?? null) : null
  })

  // region 이름은 짧게 두고 탈출 안내는 보이는 한 줄 + aria-describedby 로 연결한다 — 이름·설명 중복 낭독 방지(AX-18)
  return (
    <LiveSessionsContext.Provider value={live}>
      <div
        className={visible ? 'absolute inset-0 flex flex-col' : 'hidden'}
        style={{ background: terminalBackground(theme) }}
        data-testid="terminal-tab"
        role="region"
        aria-label="터미널"
        aria-describedby={activeStarted ? hintId : undefined}
      >
        {activeStarted && (
          <div className="flex shrink-0 flex-wrap gap-x-4 px-3 pt-1.5 text-xs text-neutral-400 max-md:hidden">
            <p id={hintId}>{TERMINAL_EXIT_HINT}: 터미널 밖으로 이동</p>
            <p>
              {openKeyWorks && `${PANE_KEYS.open}: 새 터미널 · `}
              {PANE_KEYS.splitRight}: 오른쪽 분할 · {PANE_KEYS.splitDown}: 아래 분할 · {PANE_KEYS.close}: 패널 닫기 · {CLIPBOARD_KEYS.copy}:
              복사(선택했을 때) · {CLIPBOARD_KEYS.paste}: 붙여넣기 · {EDIT_KEYS.deleteWord}: 단어 지우기 · {EDIT_KEYS.newline}: 줄바꿈
            </p>
          </div>
        )}
        {touch && activeStarted && <TerminalKeyBar paneId={activePane} />}
        <div className="relative min-h-0 flex-1">
          {sessions
            .filter((s) => s.issueId in started)
            .map((s) => (
              <IssuePanes key={sessionKey(s)} spec={s} active={visible && s.issueId === activeId} hintId={hintId} onExit={onExit} />
            ))}
          {visible && activeId !== null && activeHasSession && !activeStarted && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-neutral-400">
              <p>
                {openKeyWorks && <span className="max-md:hidden">{PANE_KEYS.open} 또는 </span>}아래 버튼으로 터미널을 엽니다
              </p>
              <Button size="sm" variant="secondary" onClick={() => openTerminal(activeId)}>
                터미널 열기
              </Button>
            </div>
          )}
          {visible && !activeHasSession && (
            <p className="p-4 text-sm text-neutral-400">worktree 가 준비되면 터미널을 사용할 수 있습니다.</p>
          )}
        </div>
      </div>
    </LiveSessionsContext.Provider>
  )
}

/** 이슈 하나의 패널들. 트리 대신 평면 목록으로 배치해 분할·닫기 때 다른 패널이 다시 마운트되지 않게 한다 */
function IssuePanes({ spec, active, hintId, onExit }: { spec: TerminalSessionSpec; active: boolean; hintId: string; onExit?: () => void }) {
  const panes = useUiStore((s) => s.panes[spec.issueId])
  const ensurePanes = useUiStore((s) => s.ensurePanes)
  const newPane = useUiStore((s) => s.newPane)
  const focusPane = useUiStore((s) => s.focusPane)
  const narrow = useNarrow()
  // panes 가 사라지면(worktree 기록 삭제 등) 마운트된 채로도 다시 만든다 — 빈 화면에 갇히지 않게
  useEffect(() => {
    if (!panes) ensurePanes(spec.issueId)
  }, [ensurePanes, panes, spec.issueId])
  if (!panes) return null
  const rects = layoutPanes(panes.tree)
  const multiple = rects.length > 1
  // 좁은 화면(휴대폰)에서는 한 번에 한 패널만 크게 보이고, 위의 번호 버튼으로 바꾼다. 가려진 패널의 터미널도 그대로 살아 있다
  const shownId = narrow ? (rects.find((r) => r.id === panes.focused) ?? rects[0])?.id : undefined
  return (
    <div className={active ? 'absolute inset-0' : 'hidden'}>
      {narrow && multiple && (
        <div role="tablist" aria-label="터미널 패널" className="absolute inset-x-0 top-0 z-10 flex h-7 gap-1 px-2">
          {rects.map((r, i) => (
            <button
              key={r.id}
              type="button"
              role="tab"
              aria-selected={r.id === shownId}
              onClick={() => focusPane(spec.issueId, r.id)}
              className={`rounded px-2.5 text-xs ${r.id === shownId ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-400'}`}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}
      {rects.map((r) => (
        <div
          key={r.id}
          className={`absolute flex flex-col ${narrow && r.id !== shownId ? 'invisible' : ''} ${!narrow && multiple && panes.focused === r.id ? 'outline outline-1 -outline-offset-1 outline-ring' : ''}`}
          style={
            narrow
              ? { left: 0, right: 0, bottom: 0, top: multiple ? '1.75rem' : 0 }
              : { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }
          }
          data-testid="terminal-pane"
        >
          <PaneAgentStrip paneId={r.id} />
          <div className="relative min-h-0 flex-1">
            <TerminalSession spec={spec} paneId={r.id} active={active} hintId={hintId} onExit={onExit} />
          </div>
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
  /**
   * 이 화면이 터미널의 크기를 정하는가. 같은 터미널을 여러 화면(이 PC 의 창·원격으로 붙은 기기)이 보면 크기는 하나여야 하므로,
   * 마지막으로 입력한 화면에 맞춘다. 혼자 쓸 때는 항상 true 다.
   */
  owner: boolean
  /** PTY 에 지금 xterm 의 크기를 알린다 — 이 터미널이 보낸 요청임을 표시해, 늦게 온 자기 알림을 다른 화면의 변경으로 읽지 않는다 */
  askResize(): void
  /** 보이는 동안만 있다 — 패널에 크기를 맞추고 PTY 에 알린다 */
  refit?: () => void
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
  const live = useContext(LiveSessionsContext)
  // 객체가 아니라 값으로 비교해야 세션 목록이 다시 만들어질 때 터미널을 새로 띄우지 않는다
  const remoteHost = spec.remote?.host
  // 패널을 처음 열 때의 값으로 고정한다 — 설정(원격 터미널에 tmux 사용)을 바꿔도 돌고 있는 터미널을 다시 띄우지 않게.
  // 바꾼 값은 새로 여는 터미널과 [다시 시작] 한 터미널부터 쓴다
  const [remoteTmux, setRemoteTmux] = useState(() => spec.remote?.tmux ?? false)
  const theme = useUiStore((s) => s.theme)
  const fontSize = useUiStore((s) => s.fontSize)
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
    /** 한글 등의 조합이 방금 끝났다(그 글자를 xterm 이 아직 보내지 않았다) */
    let justComposed = false
    const t = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: useUiStore.getState().fontSize,
      theme: terminalTheme(useUiStore.getState().theme),
      // 출력을 스크린 리더가 읽을 수 있는 접근성 트리로도 내보낸다
      screenReaderMode: true,
      // 아래의 글자 폭 설정(t.unicode)이 proposed API 다
      allowProposedApi: true,
    })
    // 글자 폭을 Unicode 11 로 맞춘다. ConPTY 와 Claude Code 는 이모지(✅ 🚀 등)를 2칸으로 세는데 xterm 기본(Unicode 6)은 1칸이다.
    // ConPTY 는 바뀐 칸만 절대 위치로 보내므로, 폭이 다르면 이모지가 있는 줄의 글자가 밀리고 지워지지 않은 조각이 남는다
    t.loadAddon(new Unicode11Addon())
    t.unicode.activeVersion = '11'
    const ui = useUiStore.getState
    t.attachCustomKeyEventHandler(
      createTerminalKeyHandler(
        () => onExitRef.current?.(),
        {
          splitRight: () => ui().splitPane(spec.issueId, paneId, 'row'),
          splitDown: () => ui().splitPane(spec.issueId, paneId, 'col'),
          // 패널이 없어지면 아래 cleanup 이 PTY(와 그 자손 프로세스)를 종료한다
          close: () => ui().closePane(spec.issueId, paneId),
        },
        {
          hasSelection: () => t.hasSelection(),
          selection: () => t.getSelection(),
          // 클립보드를 쓸 수 없는 환경이어도 터미널은 계속 쓸 수 있게 실패는 무시한다
          copy: (text) => void navigator.clipboard?.writeText(text).catch(() => undefined),
          clearSelection: () => t.clearSelection(),
        },
        // 사용자가 친 글자처럼 넣는다 — onData 를 거쳐 PTY 로 간다.
        // 한글 조합이 막 끝났을 때만 한 박자 늦춘다: xterm 은 조합이 끝난 글자를 setTimeout(0) 으로 보내므로,
        // 바로 보내면 마지막 글자보다 먼저 간다. 평소에는 바로 보낸다(늦추면 바로 뒤에 친 키와 순서가 뒤바뀐다)
        (data) => {
          if (!justComposed) return t.input(data)
          setTimeout(() => {
            if (!disposed) t.input(data)
          }, 0)
        },
      ),
    )
    const fit = new FitAddon()
    t.loadAddon(fit)
    // xterm 입력 textarea 의 aria-label 은 open() 때 정해지므로 그 전에 한국어로 바꾼다(전역 설정, AX-39)
    Terminal.strings.promptLabel = '터미널 입력'
    t.open(el)
    // 입력 textarea 에도 탈출 안내를 연결한다 — region 에만 있으면 입력에 포커스를 둔 사용자는 듣지 못한다(AX-39)
    t.textarea?.setAttribute('aria-describedby', hintId)
    /** 이 터미널의 크기 변경 요청 표시(`<origin>:<번호>`), 마지막으로 보낸 요청 번호, 알림을 받은 가장 큰 요청 번호 */
    const origin = newOrigin()
    let asked = 0
    let seen = 0
    const state: TermState = {
      t,
      fit,
      ptyId: null,
      ended: false,
      owner: true,
      askResize: () => {
        if (!state.ptyId || state.ended) return
        asked += 1
        // reject 는 무시한다 — 종료 판정은 write reject 만(CR-19)
        tauri.ptyResize(state.ptyId, t.cols, t.rows, `${origin}:${asked}`).catch(() => undefined)
      },
      end: () => {
        if (disposed || state.ended) return
        state.ended = true
        focusRestartButton.current = el.contains(document.activeElement)
        setEnded(true)
      },
    }
    term.current = state
    // 클릭·Tab 으로 들어온 패널을 "현재 패널" 로 표시한다(분할·닫기 대상)
    /**
     * 다른 화면의 크기에 맞춰 보던 터미널을 이 화면의 크기로 가져온다. 바꿨으면 true.
     * 글자를 치는 순간이 아니라 터미널을 누를(포커스할) 때 한다 — 크기 변경과 입력이 겹치면 셸(PSReadLine)이 그 글자를 잃는다
     * (실제로 확인: 붙은 터미널에서 첫 글자가 사라졌다).
     */
    const takeOver = (): boolean => {
      if (state.owner || !state.ptyId || state.ended) return false
      state.owner = true
      try {
        fit.fit()
      } catch {
        return false
      }
      state.askResize()
      return true
    }
    const onFocus = () => {
      useUiStore.getState().focusPane(spec.issueId, paneId)
      takeOver()
    }
    t.textarea?.addEventListener('focus', onFocus)
    // 사용자가 직접 넣은 입력(키·붙여넣기)의 에코를 에이전트의 출력으로 세지 않게 알린다.
    // xterm 이 프로그램의 질의에 자동으로 답하는 것(포커스·마우스·커서 위치 보고)은 입력으로 치지 않는다
    const onUserInput = () => noteTerminalInput(paneId)
    t.textarea?.addEventListener('keydown', onUserInput)
    // xterm 의 compositionend 처리(위 open 때 등록) 뒤에 실행되므로, 이 타이머는 xterm 이 조합 글자를 보내는 타이머 다음에 돈다
    const onCompositionEnd = () => {
      justComposed = true
      setTimeout(() => (justComposed = false), 0)
    }
    t.textarea?.addEventListener('compositionend', onCompositionEnd)
    t.textarea?.addEventListener('paste', onUserInput)
    // 화면의 키 줄(휴대폰)이 이 터미널에 키를 넣을 수 있게 등록한다
    const unregisterInput = registerTerminalInput(paneId, (data) => {
      onUserInput()
      // 포커스 없이 누른 경우 크기를 먼저 가져오고, 그 변경이 끝날 틈을 둔 뒤 넣는다
      if (!takeOver()) return t.input(data)
      setTimeout(() => {
        if (!disposed) t.input(data)
      }, TAKE_OVER_SETTLE_MS)
    })
    // [다시 시작] 버튼이 사라지며 포커스를 잃으므로, 사용자가 시작한 재시작에 한해 새 터미널로 포커스를 옮긴다(자동 포커스 금지 AX-02 의 예외)
    if (focusAfterRestart.current) {
      focusAfterRestart.current = false
      t.focus()
    }
    const cleanups: (() => void)[] = []

    void (async () => {
      // spawn 응답(id 확정) 전에 온 출력은 첫 프롬프트일 수 있어 id 별로 보관했다가 확정 후 flush 한다(CR-07)
      const pending = new Map<string, { data: string; end?: number }[]>()
      let pendingChars = 0
      let settled = false
      let replaying = false
      // [에이전트 실행] 으로 맡겨 둔 명령은 셸이 출력을 내고 잠잠해진 뒤에 한 번 넣는다.
      // null = 아직 꺼내지 않음, undefined = 없음(또는 이미 넣음)
      let launchCmd: string | undefined | null = null
      let launchTimer: ReturnType<typeof setTimeout> | undefined
      cleanups.push(() => clearTimeout(launchTimer))
      const launchWhenReady = () => {
        if (!state.ptyId) return
        if (launchCmd === null) launchCmd = takeLaunch(paneId)
        if (launchCmd === undefined) return
        const id = state.ptyId
        clearTimeout(launchTimer)
        launchTimer = setTimeout(() => {
          if (disposed || state.ended || !launchCmd) return
          // ssh 가 비밀번호·호스트 키를 묻는 중이면 넣지 않고 다음 출력을 기다린다
          const buf = t.buffer?.active
          const line = buf?.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? ''
          if (looksLikeAuthPrompt(line)) return
          const cmd = launchCmd
          launchCmd = undefined
          tauri.ptyWrite(id, `${cmd}\r`).catch(state.end)
        }, LAUNCH_DELAY_MS)
      }
      try {
        const unlisten = await tauri.onPtyData((e) => {
          if (disposed) return
          if (e.id === state.ptyId) {
            t.write(e.data)
            launchWhenReady()
            return
          }
          // 확정 후(또는 spawn 실패 후)의 다른 id 는 다른 세션 출력 — 버린다
          if (settled) return
          if (pendingChars >= MAX_PENDING_PTY_CHARS) return
          const data = e.data.slice(0, MAX_PENDING_PTY_CHARS - pendingChars)
          pendingChars += data.length
          pending.set(e.id, [...(pending.get(e.id) ?? []), { data, end: e.end }])
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
        // 첫 출력을 그리기 전에 ConPTY 정보를 준다 — 행이 늘 때 xterm 이 스크롤백을 화면으로 끌어오지 않고 ConPTY 처럼
        // 아래에 빈 행을 둔다(다르면 두 화면이 어긋난다). 기다리는 동안 온 출력은 위의 pending 에 쌓인다
        const windowsPty = await hostWindowsPty(tauri)
        if (disposed) return
        if (windowsPty) t.options.windowsPty = windowsPty
        const remote = remoteHost === undefined ? undefined : remotePty(remoteHost, remoteTmux, spec.cwd, paneRole(spec.issueId, paneId))
        // 이 패널의 터미널이 이미 떠 있으면(다른 화면이 열었거나, 이 화면이 잠시 내려갔다 돌아온 경우) 새로 만들지 않고 붙는다
        const found = await tauri.ptyFind(paneId)
        const id = found
          ? found.id
          : await tauri.ptySpawn({ cwd: spec.cwd, cols: Math.max(t.cols, 20), rows: Math.max(t.rows, 5), remote, key: paneId })
        settled = true
        if (disposed) {
          pending.clear()
          // 방금 이 화면이 만든 터미널만 정리한다 — 붙기만 한 터미널은 다른 화면이 쓰고 있다
          if (!found && !paneExists(spec.issueId, paneId)) tauri.ptyKill(id).catch(() => undefined)
          return
        }
        state.ptyId = id
        if (found) {
          // 지금까지의 출력을 그 터미널의 크기로 그린다(크기가 다르면 줄바꿈 위치가 어긋난다). 크기는 이 화면에서 입력할 때 가져온다
          state.owner = false
          if (found.cols > 0 && found.rows > 0) t.resize(found.cols, found.rows)
          // 다시 그리는 동안에는 터미널이 내는 입력을 보내지 않는다 — 지난 출력 속의 질의(커서 위치·장치 속성 등)에
          // xterm 이 또 답하면 그 답이 셸에 글자로 들어간다(이미 그때의 화면이 답한 질의다)
          replaying = true
          t.write(found.scrollback, () => {
            replaying = false
          })
          launchWhenReady()
        }
        // 응답을 기다리는 동안 온 조각을 이어 그린다. 붙은 경우에는 지난 출력(scrollback)이 담은 위치보다 뒤의 것만 —
        // 그 앞의 조각은 이미 scrollback 에 들어 있다(위치를 모르는 조각은 겹칠 수 있으므로 버린다)
        const early = (pending.get(id) ?? [])
          .filter((c) => !found || (c.end !== undefined && c.end > found.offset))
          .map((c) => c.data)
          .join('')
        pending.clear()
        if (early) {
          t.write(early)
          launchWhenReady()
        }
        const unExit = await tauri.onPtyExit((ended) => {
          if (ended === id) state.end()
        })
        // 알림은 PTY 에 적용된 순서로 온다(요청마다 하나씩) — 마지막으로 받은 알림의 크기가 곧 PTY 의 크기다
        const adopt = (cols: number, rows: number) => {
          if (cols !== t.cols || rows !== t.rows) t.resize(cols, rows)
        }
        const unResized = await tauri.onPtyResized((e) => {
          if (disposed || e.id !== id) return
          if (e.by?.startsWith(`${origin}:`)) {
            const n = Number(e.by.slice(origin.length + 1))
            if (n < seen) {
              // 더 새 요청보다 늦게 적용됐다(원격 호출은 따로 돈다) — PTY 가 옛 크기가 됐다.
              // 크기를 정하는 중이면 지금 크기를 다시 알리고, 다른 화면의 크기로 보는 중이면 따른다
              if (state.owner) state.askResize()
              else adopt(e.cols, e.rows)
              return
            }
            seen = n
            // 옛 요청의 알림 — 더 새 요청의 알림이 뒤따른다. 따르면 xterm 이 옛 크기로 돌아갔다 다시 바뀌며(reflow)
            // ConPTY 의 화면과 어긋나 잔상이 남고, 다른 화면의 변경으로 읽어 크기 맞춤까지 멈춘다(#58)
            if (n !== asked) return
            // 마지막 요청이 적용됐다 — 그 사이 다른 화면의 알림으로 바뀐 크기를 PTY 의 지금 크기로 되돌린다.
            // 다른 화면의 크기로 보던 동안에는 패널 크기를 따라가지 않았으므로, 되찾았으면 패널에 다시 맞춘다
            const regained = !state.owner
            state.owner = true
            adopt(e.cols, e.rows)
            if (regained) state.refit?.()
            return
          }
          if (e.cols === t.cols && e.rows === t.rows) return
          // 다른 화면이 크기를 바꿨다 — 같은 크기로 그린다
          state.owner = false
          t.resize(e.cols, e.rows)
        })
        if (disposed) {
          unExit()
          unResized()
          return
        }
        cleanups.push(unExit, unResized)
        useUiStore.setState((s) => ({ terminalIds: { ...s.terminalIds, [paneId]: id } }))
        const sub = t.onData((d) => {
          if (state.ended || replaying) return
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
      t.textarea?.removeEventListener('keydown', onUserInput)
      t.textarea?.removeEventListener('compositionend', onCompositionEnd)
      t.textarea?.removeEventListener('paste', onUserInput)
      unregisterInput()
      for (const c of cleanups) c()
      // 패널이 없어졌거나(닫기), 세션이 목록에서 빠졌거나(작업 폴더 삭제), 끝난 터미널을 다시 시작할 때만 끝낸다. 패널이 그대로면(호스트 전환 등으로
      // 화면만 내려간 경우) 터미널은 남겨 둔다 — 다른 기기가 보고 있을 수 있고, 돌아오면 다시 붙는다.
      // kill 의 reject(이미 종료된 PTY 등)는 무시한다
      const sessionGone = live.current.mounted && !live.current.keys.has(sessionKey(spec))
      if (state.ptyId && (state.ended || sessionGone || !paneExists(spec.issueId, paneId)))
        tauri.ptyKill(state.ptyId).catch(() => undefined)
      useUiStore.setState((s) => {
        const terminalIds = { ...s.terminalIds }
        delete terminalIds[paneId]
        return { terminalIds }
      })
      t.dispose()
      term.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- live 는 바뀌지 않는 ref 다
  }, [tauri, spec.cwd, spec.issueId, remoteHost, remoteTmux, paneId, hintId, gen])

  // 보이는 동안만 WebGL 로 그린다. 이슈·패널마다 터미널이 숨은 채 살아 있어 모두 켜 두면 페이지당 WebGL context 상한
  // (Chromium 약 16개)을 넘고, 넘친 만큼 오래된 터미널의 context 가 끊긴다. 숨은 동안은 DOM 렌더러로 둔다
  useEffect(() => {
    const cur = term.current
    if (!active || !cur) return
    return attachWebgl(cur.t)
  }, [active, gen])

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
    if (cur) cur.t.options.theme = terminalTheme(theme)
  }, [theme])

  // 글자 크기 변경을 열린 터미널에도 반영 — 칸 수가 달라지므로 아래의 크기 맞춤(effect)이 이어서 다시 돈다
  useEffect(() => {
    const cur = term.current
    if (cur) cur.t.options.fontSize = fontSize
  }, [fontSize, gen])

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
      // 다른 화면의 크기로 보는 중에는 맞추지 않는다(입력하면 이 화면의 크기로 돌아온다)
      if (!cur || !cur.owner) return
      try {
        cur.fit.fit()
      } catch {
        return
      }
      cur.askResize()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    // 크기를 정하는 일을 알림으로 되찾았을 때도 패널에 맞출 수 있게 둔다(보이는 동안만)
    const cur = term.current
    if (cur) cur.refit = resize
    return () => {
      ro.disconnect()
      if (cur?.refit === resize) cur.refit = undefined
    }
  }, [active, gen, fontSize])

  const restart = () => {
    focusAfterRestart.current = true
    setEnded(false)
    setError(null)
    // 어차피 새 PTY 를 만드므로 지금 설정을 따른다(예: 연결이 끊겨 tmux 를 켠 뒤 다시 시작)
    setRemoteTmux(spec.remote?.tmux ?? false)
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
        <div className="absolute inset-x-2 bottom-2 z-10 flex items-center gap-3 rounded border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
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
