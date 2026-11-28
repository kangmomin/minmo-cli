// 터미널 (F-04, AC-08): worktree 경로를 cwd 로 하는 PTY + xterm 렌더.
// 이슈를 전환해도 세션이 유지되도록 열린 이슈마다 세션을 만들어 두고 선택된 것만 보여 준다.
// 이슈 안에서는 패널을 나눌 수 있고(Ctrl+D / Ctrl+Shift+D), 패널마다 PTY 하나를 가진다(Ctrl+W 로 닫으면 프로세스 트리 종료).
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import { createContext, memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'

import { useBaseDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { hasTerminalTabs } from '../../lib/defaultWorkspace'
import { newOrigin } from '../../lib/sharedState'
import { remotePty } from '../../lib/sshHost'
import type { PtyTmux, TauriApi, WindowsPty } from '../../lib/tauri'
import { terminalBackground, terminalTheme } from '../../lib/theme'
import { useUiStore } from '../../store/ui'
import type { UiState } from '../../store/ui'
import { LAUNCH_DELAY_MS, dropLaunch, isLaunchCancelled, looksLikeAuthPrompt, markLaunched, takeLaunch } from '../agents/launchQueue'
import { muteTerminalActivity, notePtySize, noteTerminalInput } from '../agents/useAgentTracker'
import { PaneAgentStrip } from '../agents/AgentBadge'
import { CLIPBOARD_KEYS, EDIT_KEYS, MOUSE_KEYS, PANE_KEYS, TERMINAL_EXIT_HINT, createTerminalKeyHandler } from './keys'
import { attachLinks } from './links'
import { attachOsc52 } from './osc52'
import { ReconnectNotice } from './ReconnectNotice'
import { TerminalKeyBar, registerTerminalInput, useNarrow, useTouch } from './TerminalKeyBar'
import { killPaneTerminal, paneSeq } from './endPanes'
import { activeTabOf, effectivePane, isPaneTree, layoutPanes, leafIds, selectedTabId, tabList } from './panes'
import type { PaneNode } from './panes'
import { newTerminalButtonId, tabDomIds } from './tabIds'
import { TerminalTabsBar } from './TerminalTabsBar'
import { registerTerminalText } from './terminalText'
import { usePtyLink } from './usePtyLink'
import { attachWebgl } from './webgl'

/** remote 가 있으면 그 호스트(SSH 프로필)의 cwd 에서 터미널을 연다 */
/** remote.tmux: 전용 tmux 세션으로 여는가(설정이 켜져 있고 원격에 tmux 가 있을 때) */
export type TerminalSessionSpec = { issueId: string; cwd: string; remote?: { host: string; tmux: boolean } }

/**
 * 원격 tmux 세션 선택: 이슈의 첫 패널(first)이 기본 세션, 나머지는 그 패널의 세션(-pN — 패널을 닫을 때 끝낸다). 둘 다 앱을 꺼도 남는다.
 * first 는 분할·닫기로 바뀌지 않는다 — 첫 패널을 닫아도 남은 패널이 기본 세션으로 옮겨 붙지 않고 자기 세션에 다시 붙게(#89 D-26)
 */
function paneRole(issueId: string, paneId: string) {
  const first = useUiStore.getState().firstPane(issueId)
  return { primary: first === null || first === paneId, seq: paneSeq(paneId) }
}

/** 터미널 크기를 가져온 뒤 입력을 넣기까지 두는 틈 — 크기 변경과 입력이 겹치면 셸이 그 입력을 잃는다 */
const TAKE_OVER_SETTLE_MS = 250
/** 원격 터미널이 다시 접속할 때 그 패널의 출력을 에이전트 활동으로 세지 않는 시간(#89) */
const RECONNECT_MUTE_MS = 3000

/** 패널이 아직 화면 구성에 있는가 — 없어진 패널의 터미널만 끝낸다 */
function paneExists(issueId: string, paneId: string): boolean {
  const tree = useUiStore.getState().panes[issueId]?.tree ?? null
  // Why: 깨진 공유 트리를 받아도 이 기기의 터미널을 끄지 않는다(그 트리는 읽을 때만 "패널 없음"이다)
  if (tree !== null && !isPaneTree(tree)) return true
  return leafIds(tree).includes(paneId)
}

// Why: 수정 키만 누르면 키 처리기는 true 를 돌려주지만 xterm 은 아무것도 보내지 않는다 — 입력으로 세지 않는다
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock'])

/** ptySpawn 응답 전에 도착한 pty-data 를 id 별로 보관하는 상한(문자 수) */
export const MAX_PENDING_PTY_CHARS = 256 * 1024

/** 클립보드에 쓴다(Ctrl+C 복사·프로그램의 OSC 52). 쓸 수 없는 환경이어도 터미널은 계속 쓸 수 있게 실패는 무시한다 */
function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined)
}

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
  /** Why: 답변 모드(#122): 지금 패널 하나만 전체 크기로 */
  singlePane?: boolean
  /** Why: 답변 모드(#122): 터미널 입력이 함께 읽을 설명 요소 id */
  describedBy?: string
}

/**
 * 지금 유지하는 세션들 — 세션이 목록에서 빠져(작업 폴더 삭제 등) 내려가는 터미널은 끝내고,
 * 터미널 탭 전체가 내려가는 경우(호스트 전환 등)에는 남겨 두기 위해 구분한다.
 */
type LiveSessions = { mounted: boolean; keys: Set<string> }
const LiveSessionsContext = createContext<{ current: LiveSessions }>({ current: { mounted: false, keys: new Set() } })
const sessionKey = (s: Pick<TerminalSessionSpec, 'issueId' | 'cwd'>) => `${s.issueId}|${s.cwd}`

export function TerminalTab({ sessions, activeId, visible, onExit, singlePane = false, describedBy }: TerminalTabProps) {
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
    if (!visible || !activeId || !activeHasSession || activeStarted || !activeAlive) return
    const ui = useUiStore.getState()
    const p = ui.panes[activeId]
    const hasPty = (t: { node: PaneNode }) => leafIds(t.node).some((id) => id in ui.terminalIds)
    const selected = activeTabOf(p?.tree ?? null, p?.tab)
    // Why: 떠 있는 터미널이 숨은 탭에만 있으면 그 탭으로 바꿔 붙는다 — 고른 탭에 사용자가 열지 않은 셸을 만들지 않게
    const alive = selected && !hasPty(selected) ? tabList(p?.tree ?? null).find(hasPty) : undefined
    if (alive) ui.selectTab(activeId, alive.id)
    ui.markTerminalStarted(activeId)
  }, [visible, activeId, activeHasSession, activeStarted, activeAlive])

  // 세션이 사라지면(worktree 삭제 등) started 에서도 뺀다 — 다시 나타나도 사용자가 열 때까지 PTY 를 만들지 않도록
  const sessionIds = sessions.map((s) => s.issueId).join('\n')
  useEffect(() => {
    useUiStore.getState().pruneStartedTerminals(new Set(sessionIds.split('\n')))
  }, [sessionIds])

  const theme = useUiStore((s) => s.theme)
  // 화면 키보드를 쓰는 기기에는 Esc·Tab·방향키 줄을 둔다 — 지금 이슈의 포커스한(없으면 첫) 패널로 보낸다
  const touch = useTouch()
  const activePane = useUiStore((s) => (activeId ? effectivePane(s.panes[activeId]) : null))

  const tabsHere = activeId !== null && hasTerminalTabs(activeId)
  const activeTabCount = useUiStore((s) => (activeId ? tabList(s.panes[activeId]?.tree ?? null).length : 0))
  const activeSpec = sessions.find((s) => s.issueId === activeId)
  // Why: 답변 모드(#122)는 지금 패널 하나만 보인다 — 탭 줄을 두지 않고, Ctrl+Shift+M 은 요약 카드로 간다(EC-15)
  const showTabs = !singlePane && tabsHere && activeStarted && activeTabCount > 0 && activeSpec !== undefined
  // Why: 키 핸들러는 터미널마다 1회 연결하므로 최신 onExit 를 ref 로 읽는다
  const onExitRef = useRef(onExit)
  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])
  // Why: 기본은 작업 탭 줄이 숨어 있다 — 탭 줄이 있으면 Ctrl+Shift+M 은 고른 터미널 탭 버튼으로 간다
  const exitTerminal = useCallback((issueId: string) => {
    const p = useUiStore.getState().panes[issueId]
    const tabId = hasTerminalTabs(issueId) ? selectedTabId(p?.tree ?? null, p?.tab) : null
    const button = tabId === null ? null : document.getElementById(tabDomIds(issueId, tabId).tab)
    if (button) button.focus()
    else onExitRef.current?.()
  }, [])

  // region 이름은 짧게 두고 탈출 안내는 보이는 한 줄 + aria-describedby 로 연결한다 — 이름·설명 중복 낭독 방지(AX-18)
  return (
    <LiveSessionsContext.Provider value={live}>
      <div
        className={visible ? 'absolute inset-0 flex flex-col' : 'hidden'}
        style={{ background: terminalBackground(theme) }}
        data-testid="terminal-tab"
        data-terminal-root
        role="region"
        aria-label="터미널"
        aria-describedby={activeStarted ? hintId : undefined}
      >
        {/* Why: 이슈가 바뀌면 입력란·닫기 확인 state 를 버린다 — 다른 이슈의 같은 id 탭을 건드리지 않게 */}
        {showTabs && <TerminalTabsBar key={activeId} spec={activeSpec} />}
        {activeStarted && (
          <div className="flex shrink-0 flex-wrap gap-x-4 px-3 pt-1.5 text-xs text-neutral-400 max-md:hidden">
            <p id={hintId}>{TERMINAL_EXIT_HINT}: 터미널 밖으로 이동</p>
            <p>
              {tabsHere && !singlePane ? (
                <>
                  {openKeyWorks && `${PANE_KEYS.open}: 새 탭 · `}탭에서 F2: 이름 바꾸기 · Delete: 탭 닫기 ·{' '}
                </>
              ) : (
                openKeyWorks && `${PANE_KEYS.open}: 새 터미널 · `
              )}
              {PANE_KEYS.splitRight}: 오른쪽 분할 · {PANE_KEYS.splitDown}: 아래 분할 · {PANE_KEYS.close}: 패널 닫기 · {CLIPBOARD_KEYS.copy}:
              복사(선택했을 때) · {CLIPBOARD_KEYS.paste}: 붙여넣기 · {EDIT_KEYS.deleteWord}: 단어 지우기 · {EDIT_KEYS.newline}: 줄바꿈 ·{' '}
              {MOUSE_KEYS.openLink}: 링크 열기 · {MOUSE_KEYS.forceSelect}: 프로그램이 마우스를 쓸 때 선택
            </p>
          </div>
        )}
        {touch && activeStarted && <TerminalKeyBar issueId={activeId} paneId={activePane} singlePane={singlePane} />}
        <div className="relative min-h-0 flex-1">
          {sessions
            .filter((s) => s.issueId in started)
            .map((s) => (
              <IssuePanes
                key={sessionKey(s)}
                spec={s}
                active={visible && s.issueId === activeId}
                hintId={hintId}
                onExit={exitTerminal}
                tabsAria={showTabs && s.issueId === activeId}
                singlePane={singlePane}
                describedBy={describedBy}
              />
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

type IssuePanesProps = {
  spec: TerminalSessionSpec
  active: boolean
  hintId: string
  onExit: (issueId: string) => void
  tabsAria: boolean
  singlePane: boolean
  describedBy?: string
}

// Why: memo — 탭을 바꿔도 다른 이슈의 패널은 다시 그리지 않는다
const IssuePanes = memo(function IssuePanes({ spec, active, hintId, onExit, tabsAria, singlePane, describedBy }: IssuePanesProps) {
  const issueId = spec.issueId
  const panes = useUiStore((s) => s.panes[issueId])
  const ensurePanes = useUiStore((s) => s.ensurePanes)
  const newPane = useUiStore((s) => s.newPane)
  // Why: 글자로 골라 다른 패널의 터미널이 뜰 때마다 다시 그리지 않는다
  const ptyTabs = useUiStore((s) =>
    tabList(s.panes[issueId]?.tree ?? null)
      .filter((t) => leafIds(t.node).some((p) => p in s.terminalIds))
      .map((t) => t.id)
      .join('\n'),
  )
  const tree = panes?.tree ?? null
  const tabs = useMemo(() => tabList(tree), [tree])
  const selected = selectedTabId(tree, panes?.tab)
  // Why: 다시 켠 뒤에는 고른 탭만 셸을 시작한다. 한 번 고른 탭·PTY 가 있는 탭은 닫기 전까지 내리지 않는다(숨은 탭 PTY 유지)
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set())
  const keep = tabs.filter((t) => t.id === selected || visited.has(t.id)).map((t) => t.id)
  if (keep.length !== visited.size || keep.some((id) => !visited.has(id))) setVisited(new Set(keep))
  const exit = useCallback(() => onExit(issueId), [onExit, issueId])
  // Why: 터미널을 쓰던 중 마지막 패널을 닫으면 사라진 터미널 대신 [새 터미널] 로 포커스를 옮긴다
  const focusNew = useRef(false)
  const onLastClose = useCallback(() => {
    focusNew.current = true
  }, [])
  const newButton = useRef<HTMLButtonElement>(null)
  const empty = leafIds(tree).length === 0
  useEffect(() => {
    if (!focusNew.current) return
    focusNew.current = false
    if (empty && active) newButton.current?.focus()
  })
  // panes 가 사라지면(worktree 기록 삭제 등) 마운트된 채로도 다시 만든다 — 빈 화면에 갇히지 않게
  useEffect(() => {
    if (!panes) ensurePanes(issueId)
  }, [ensurePanes, panes, issueId])
  if (!panes) return null
  const withPty = ptyTabs.split('\n')
  return (
    <div className={active ? 'absolute inset-0' : 'hidden'}>
      {tabs.map((t) => {
        const shown = t.id === selected
        const ids = tabsAria ? tabDomIds(issueId, t.id) : undefined
        // Why: 아직 그리지 않는 탭도 자리를 둬 aria-controls 가 늘 맞다. key 가 탭 id 라 t0 로 감싸도 다시 마운트되지 않는다
        return (
          <div key={t.id} className={shown ? 'absolute inset-0' : 'hidden'} role={ids && 'tabpanel'} id={ids?.panel} aria-labelledby={ids?.tab}>
            {(shown || visited.has(t.id) || withPty.includes(t.id)) && (
              <TabPanes
                spec={spec}
                node={t.node}
                focused={panes.focused}
                active={active && shown}
                hintId={hintId}
                onExit={exit}
                onLastClose={onLastClose}
                singlePane={singlePane}
                describedBy={describedBy}
              />
            )}
          </div>
        )
      })}
      {empty && active && (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-neutral-400">
          <p>터미널 패널을 모두 닫았습니다</p>
          <Button ref={newButton} id={newTerminalButtonId(issueId)} size="sm" variant="secondary" onClick={() => newPane(issueId)}>
            새 터미널
          </Button>
        </div>
      )}
    </div>
  )
})

type TabPanesProps = {
  spec: TerminalSessionSpec
  node: PaneNode
  focused: string | null
  active: boolean
  hintId: string
  onExit: () => void
  onLastClose: () => void
  singlePane: boolean
  describedBy?: string
}

/** Why: 트리 대신 평면 목록으로 배치해 분할·닫기 때 다른 패널이 다시 마운트되지 않게 한다 */
function TabPanes({ spec, node, focused, active, hintId, onExit, onLastClose, singlePane, describedBy }: TabPanesProps) {
  const focusPane = useUiStore((s) => s.focusPane)
  const narrow = useNarrow()
  const rects = layoutPanes(node)
  const multiple = rects.length > 1
  // Why: 좁은 화면(휴대폰)·답변 모드에서는 한 번에 한 패널만 크게 보인다(좁은 화면은 위의 번호 버튼으로 바꾼다). 가려진 패널의 터미널도 그대로 살아 있다
  const single = narrow || singlePane
  const shownId = single ? effectivePane({ tree: node, focused }) : undefined
  return (
    <>
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
          className={`absolute flex flex-col ${single && r.id !== shownId ? 'invisible' : ''} ${!single && multiple && focused === r.id ? 'outline outline-1 -outline-offset-1 outline-ring' : ''}`}
          style={
            single
              ? { left: 0, right: 0, bottom: 0, top: narrow && multiple ? '1.75rem' : 0 }
              : { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }
          }
          data-testid="terminal-pane"
          data-pane-id={r.id}
        >
          <PaneAgentStrip paneId={r.id} />
          <div className="relative min-h-0 flex-1">
            <TerminalSession spec={spec} paneId={r.id} active={active} hintId={hintId} onExit={onExit} onLastClose={onLastClose} describedBy={describedBy} />
          </div>
        </div>
      ))}
    </>
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
  /**
   * 이 xterm 이 처리한 마지막 포커스 요청 — 인스턴스마다 둬야 StrictMode 재마운트로 새로 만든 xterm 도 포커스를 받는다.
   * token 이 아니라 요청 객체로 비교한다: 처리한 요청을 지우면 다음 요청의 token 이 다시 1 부터 시작해, 같은 패널의 새 요청을 놓친다(#78)
   */
  handledFocus?: UiState['focusRequest']
}

function TerminalSession({
  spec,
  paneId,
  active,
  hintId,
  onExit,
  onLastClose,
  describedBy,
}: {
  spec: TerminalSessionSpec
  paneId: string
  active: boolean
  hintId: string
  onExit?: () => void
  onLastClose?: () => void
  describedBy?: string
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
  const onLastCloseRef = useRef(onLastClose)
  useEffect(() => {
    onExitRef.current = onExit
    onLastCloseRef.current = onLastClose
  }, [onExit, onLastClose])
  // 원격 터미널의 연결 상태(#89) — ① 다시 접속하는 중 · ② 다시 접속하지 못함 · ③ 다시 접속했음
  const reconnectButton = useRef<HTMLButtonElement>(null)
  const noticeId = useId()
  /** 마지막 연결 상태 이벤트를 받을 때(화면이 바뀌기 전) 포커스가 있던 곳 — 실패 안내로 바뀌거나 안내가 사라질 때 쓴다 */
  const linkFocus = useRef<'terminal' | 'notice' | null>(null)
  const link = usePtyLink(tauri, (e) => {
    const focused = document.activeElement
    linkFocus.current = host.current?.contains(focused) ? 'terminal' : focused !== null && focused === reconnectButton.current ? 'notice' : null
    // 다시 접속할 때의 준비 출력·구분 줄·tmux 다시 그리기는 에이전트의 출력이 아니다 — 이 이벤트가 그 데이터보다 먼저 온다
    if (e.phase === 'connecting' || e.phase === 'connected') muteTerminalActivity(paneId, RECONNECT_MUTE_MS)
  })
  const { attach: attachLink, setId: setLinkId, linkRef } = link

  // 세션 생성: 마운트 1회(다시 시작 시 gen 이 바뀌면 다시). 언마운트(이슈의 worktree 삭제 등) 시 PTY 종료
  useEffect(() => {
    const el = host.current
    if (!el) return
    let disposed = false
    /** 한글 등의 조합이 방금 끝났다(그 글자를 xterm 이 아직 보내지 않았다) */
    let justComposed = false
    /** 이미 떠 있던 터미널의 지난 출력을 다시 그리는 중이다 — 그 안의 질의 답·복사(OSC 52)는 그때 이미 처리됐다 */
    let replaying = false
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
    // ssh 원격의 프로그램은 이 PC 의 브라우저·클립보드를 쓸 수 없다(#76) — 링크는 Ctrl+클릭으로 이 화면에서 열고,
    // 프로그램의 복사(OSC 52)는 이 화면의 클립보드에 쓴다. 둘 다 t.dispose() 때 함께 풀린다.
    // 지난 출력을 다시 그릴 때의 옛 복사는 버린다 — 지금 클립보드를 옛 내용으로 덮어쓰지 않게
    attachLinks(t, (url) => void tauri.openUrl(url).catch(() => undefined))
    attachOsc52(t, (text) => {
      if (!replaying) copyText(text)
    })
    const ui = useUiStore.getState
    const keyHandler = createTerminalKeyHandler(
      () => onExitRef.current?.(),
      {
        splitRight: () => ui().splitPane(spec.issueId, paneId, 'row'),
        splitDown: () => ui().splitPane(spec.issueId, paneId, 'col'),
        // 패널이 없어지면 아래 cleanup 이 PTY(와 그 자손 프로세스)를 종료한다
        close: () => {
          // Why: 닫은 뒤에는 이 터미널이 없어 포커스를 먼저 본다
          if (el.contains(document.activeElement) && leafIds(ui().panes[spec.issueId]?.tree ?? null).length === 1) onLastCloseRef.current?.()
          ui().closePane(spec.issueId, paneId)
        },
      },
      {
        hasSelection: () => t.hasSelection(),
        selection: () => t.getSelection(),
        copy: copyText,
        clearSelection: () => t.clearSelection(),
      },
      // 사용자가 친 글자처럼 넣는다 — onData 를 거쳐 PTY 로 간다.
      // 한글 조합이 막 끝났을 때만 한 박자 늦춘다: xterm 은 조합이 끝난 글자를 setTimeout(0) 으로 보내므로,
      // 바로 보내면 마지막 글자보다 먼저 간다. 평소에는 바로 보낸다(늦추면 바로 뒤에 친 키와 순서가 뒤바뀐다)
      (data) => {
        noteTerminalInput(paneId)
        if (!justComposed) return t.input(data)
        setTimeout(() => {
          if (!disposed) t.input(data)
        }, 0)
      },
    )
    // Why: 입력은 키 처리기가 PTY 로 보내게 둔 키만 센다 — 앱 동작 키(복사 포함)는 xterm 이 capture 로 먼저 처리해
    // textarea 의 keydown 에서는 가려낼 수 없다(복사 뒤에는 선택이 이미 풀렸다)
    t.attachCustomKeyEventHandler((e) => {
      const pass = keyHandler(e)
      if (pass && e.type === 'keydown' && !MODIFIER_KEYS.has(e.key)) noteTerminalInput(paneId)
      return pass
    })
    const fit = new FitAddon()
    t.loadAddon(fit)
    // xterm 입력 textarea 의 aria-label 은 open() 때 정해지므로 그 전에 한국어로 바꾼다(전역 설정, AX-39)
    Terminal.strings.promptLabel = '터미널 입력'
    t.open(el)
    // 입력 textarea 에도 탈출 안내를 연결한다 — region 에만 있으면 입력에 포커스를 둔 사용자는 듣지 못한다(AX-39)
    t.textarea?.setAttribute('aria-describedby', hintId)
    const unregisterText = registerTerminalText(paneId, () => t.buffer?.active)
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
        // 재접속 안내의 버튼에 포커스가 있을 때 종료되면 [다시 시작]으로 옮긴다 — 버튼이 사라지며 포커스를 잃지 않게 터미널 안과 같이 본다(Plan 이 두 규칙의 겹침을 정하지 않음)
        const focused = document.activeElement
        focusRestartButton.current = el.contains(focused) || (focused !== null && focused === reconnectButton.current)
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
    // xterm 의 compositionend 처리(위 open 때 등록) 뒤에 실행되므로, 이 타이머는 xterm 이 조합 글자를 보내는 타이머 다음에 돈다
    const onCompositionEnd = () => {
      // Why: 조합이 끝난 글자는 keydown 없이 PTY 로 갈 수 있다
      onUserInput()
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
    /** 이 패널이 붙은 tmux 세션(Rust 가 가진 실제 값) — 분할 패널(-pN)이면 패널을 닫을 때 그 세션도 끝낸다(AC-06·EC-05) */
    let tmux: Promise<PtyTmux | null> = Promise.resolve(null)
    // Why: 패널을 닫았을 때(closed)만 원격 분할 세션(-pN)도 끝낸다 — [다시 시작]·세션 제거 뒤에는 그 세션에 다시 붙는다
    const kill = (id: string, closed: boolean) => {
      if (closed) void killPaneTerminal(tauri, id, remoteHost, tmux)
      else tauri.ptyKill(id).catch(() => undefined)
    }

    void (async () => {
      // spawn 응답(id 확정) 전에 온 출력은 첫 프롬프트일 수 있어 id 별로 보관했다가 확정 후 flush 한다(CR-07)
      const pending = new Map<string, { data: string; end?: number }[]>()
      let pendingChars = 0
      let settled = false
      // [에이전트 실행] 으로 맡겨 둔 명령은 셸이 출력을 내고 잠잠해진 뒤에 한 번 넣는다.
      // null = 아직 꺼내지 않음, undefined = 없음(또는 이미 넣음)
      let launchCmd: string | undefined | null = null
      let launchTimer: ReturnType<typeof setTimeout> | undefined
      cleanups.push(() => clearTimeout(launchTimer))
      cleanups.push(() => {
        if (launchCmd) dropLaunch(paneId)
      })
      const launchWhenReady = () => {
        if (!state.ptyId) return
        // 연결이 끊긴 동안의 입력은 원격으로 가지 않는다(EC-02) — 다시 연결된 뒤의 출력에서 넣는다
        if (linkRef.current !== null) return
        if (launchCmd === null) launchCmd = takeLaunch(paneId)
        if (launchCmd === undefined) return
        const id = state.ptyId
        clearTimeout(launchTimer)
        launchTimer = setTimeout(() => {
          if (disposed || state.ended || !launchCmd || linkRef.current !== null) return
          // ssh 가 비밀번호·호스트 키를 묻는 중이면 넣지 않고 다음 출력을 기다린다
          const buf = t.buffer?.active
          const line = buf?.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? ''
          if (looksLikeAuthPrompt(line)) return
          if (isLaunchCancelled(paneId)) {
            launchCmd = undefined
            return
          }
          const cmd = launchCmd
          launchCmd = undefined
          tauri.ptyWrite(id, `${cmd}\r`).then(
            () => markLaunched(paneId),
            () => {
              dropLaunch(paneId)
              state.end()
            },
          )
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
        // 연결 상태와 종료 알림은 id 가 정해지기 전(ptyFind·ptySpawn 을 기다리는 동안)부터 받는다 — 그 사이의 변화를 놓치지 않게(AC-09)
        const unLink = await attachLink()
        if (disposed) {
          unLink()
          return
        }
        cleanups.push(unLink)
        /** id 가 정해지기 전에 끝난 터미널 */
        const exitedEarly = new Set<string>()
        const unExit = await tauri.onPtyExit((ended) => {
          if (!settled) exitedEarly.add(ended)
          else if (ended === state.ptyId) state.end()
        })
        if (disposed) {
          unExit()
          return
        }
        cleanups.push(unExit)
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
        const size = { cols: Math.max(t.cols, 20), rows: Math.max(t.rows, 5) }
        const id = found ? found.id : await tauri.ptySpawn({ cwd: spec.cwd, ...size, remote, key: paneId })
        settled = true
        // Why: 추적기가 크기 변경으로 다시 그린 출력을 작업 시작과 가려내려면 PTY 의 처음 크기를 알아야 한다
        if (!found) notePtySize(id, size.cols, size.rows)
        else if (found.cols > 0 && found.rows > 0) notePtySize(id, found.cols, found.rows)
        if (found) tmux = Promise.resolve(found.tmux ?? null)
        // 이 화면이 만들었으면 실제 세션을 한 번 묻는다 — 그 사이 다른 기기(다른 tmux 설정)가 먼저 열었을 수 있다
        else if (remoteHost !== undefined) tmux = tauri.ptyFind(paneId).then((f) => (f?.id === id ? (f.tmux ?? null) : null), () => null)
        if (disposed) {
          pending.clear()
          // 방금 이 화면이 만든 터미널만 정리한다 — 붙기만 한 터미널은 다른 화면이 쓰고 있다
          if (!found && !paneExists(spec.issueId, paneId)) kill(id, true)
          return
        }
        state.ptyId = id
        // 붙었으면 ptyFind 가 알려 준 지금 연결 상태부터(그 사이에 온 이벤트와는 seq 로 비교한다)
        setLinkId(id, found?.link)
        if (exitedEarly.has(id)) state.end()
        exitedEarly.clear()
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
          unResized()
          return
        }
        cleanups.push(unResized)
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
      t.textarea?.removeEventListener('compositionend', onCompositionEnd)
      t.textarea?.removeEventListener('paste', onUserInput)
      unregisterInput()
      unregisterText()
      for (const c of cleanups) c()
      // 패널이 없어졌거나(닫기), 세션이 목록에서 빠졌거나(작업 폴더 삭제), 끝난 터미널을 다시 시작할 때만 끝낸다. 패널이 그대로면(호스트 전환 등으로
      // 화면만 내려간 경우) 터미널은 남겨 둔다 — 다른 기기가 보고 있을 수 있고, 돌아오면 다시 붙는다.
      // kill 의 reject(이미 종료된 PTY 등)는 무시한다
      const sessionGone = live.current.mounted && !live.current.keys.has(sessionKey(spec))
      const closed = !paneExists(spec.issueId, paneId)
      if (state.ptyId && (state.ended || sessionGone || closed)) kill(state.ptyId, closed)
      useUiStore.setState((s) => {
        const terminalIds = { ...s.terminalIds }
        delete terminalIds[paneId]
        return { terminalIds }
      })
      t.dispose()
      term.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- live 는 바뀌지 않는 ref 다(attachLink·setLinkId·linkRef 도 바뀌지 않는다)
  }, [tauri, spec.cwd, spec.issueId, remoteHost, remoteTmux, paneId, hintId, gen, attachLink, setLinkId, linkRef])

  // 보이는 동안만 WebGL 로 그린다. 이슈·패널마다 터미널이 숨은 채 살아 있어 모두 켜 두면 페이지당 WebGL context 상한
  // (Chromium 약 16개)을 넘고, 넘친 만큼 오래된 터미널의 context 가 끊긴다. 숨은 동안은 DOM 렌더러로 둔다
  useEffect(() => {
    const cur = term.current
    if (!active || !cur) return
    return attachWebgl(cur.t)
  }, [active, gen])

  // 분할·닫기·[새 터미널] 처럼 사용자가 패널을 바꿨거나 트리에서 이슈를 눌렀을 때(#78)만 대상 패널로 포커스를 옮긴다(AX-02 자동 포커스 금지 유지)
  useEffect(() => {
    const cur = term.current
    if (!cur || !focusRequest || focusRequest.paneId !== paneId || cur.handledFocus === focusRequest) return
    cur.handledFocus = focusRequest
    cur.t.focus()
    // 처리한 요청은 지운다 — 같은 패널 번호가 나중에 다시 마운트될 때 묵은 요청으로 포커스를 뺏지 않게(AX-02).
    // StrictMode 는 같은 커밋에서 effect 를 다시 돌리므로 그 뒤(다음 tick)에 지운다
    setTimeout(() => {
      if (useUiStore.getState().focusRequest === focusRequest) useUiStore.setState({ focusRequest: null })
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

  // 연결 상태가 바뀔 때의 포커스(#89): 실패로 바뀔 때 터미널을 쓰던 중이었으면 [재접속] 으로(AX-34 와 같은 규칙),
  // 안내가 사라질 때(다시 접속함) 그 버튼에 있었으면 터미널로 돌려준다. 그 밖에는 옮기지 않는다(AX-02)
  const linkPhase = link.link?.phase ?? null
  const prevLinkPhase = useRef(linkPhase)
  useEffect(() => {
    if (prevLinkPhase.current === linkPhase) return
    prevLinkPhase.current = linkPhase
    const was = linkFocus.current
    linkFocus.current = null
    if (linkPhase === 'failed' && was === 'terminal') reconnectButton.current?.focus()
    else if (linkPhase === null && was === 'notice') term.current?.t.focus()
  }, [linkPhase])

  // 연결이 끊긴 동안(①·②)에는 입력이 원격으로 가지 않는다 — 그 이유(①·② 문구)를 입력에도 연결한다(AX-39)
  const disconnected = !ended && linkPhase !== null
  useEffect(() => {
    const ids = [hintId, disconnected && noticeId, describedBy].filter(Boolean).join(' ')
    term.current?.t.textarea?.setAttribute('aria-describedby', ids)
  }, [disconnected, hintId, noticeId, describedBy, gen])

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
    // 새 PTY 는 이전 터미널의 연결 상태를 이어받지 않는다
    link.reset()
    linkFocus.current = null
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
      {ended ? (
        <div className="absolute inset-x-2 bottom-2 z-10 flex items-center gap-3 rounded border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
          <p role="alert" className="flex-1">
            터미널 세션이 종료되었습니다
          </p>
          <Button
            ref={restartButton}
            size="sm"
            variant="secondary"
            onClick={() => {
              // Why: 그 패널을 다시 쓰려는 사용자에게 끝남 이동(#122)이 끼어들지 않게
              noteTerminalInput(paneId)
              restart()
            }}
          >
            다시 시작
          </Button>
        </div>
      ) : (
        // 원격 터미널만 연결이 끊겨 다시 접속한다 — 종료 안내가 우선이다
        remoteHost !== undefined && (
          <ReconnectNotice
            link={link.link}
            justConnectedAt={link.justConnectedAt}
            buttonRef={reconnectButton}
            messageId={noticeId}
            // 결과는 pty-link 로 온다 — 이미 끝난 터미널 등의 거절은 무시한다
            onReconnect={() => {
              // Why: 그 패널을 다시 쓰려는 사용자에게 끝남 이동(#122)이 끼어들지 않게
              noteTerminalInput(paneId)
              const id = term.current?.ptyId
              if (id) tauri.ptyReconnect(id).catch(() => undefined)
            }}
          />
        )
      )}
      <div key={gen} ref={host} className="size-full" />
    </div>
  )
}
