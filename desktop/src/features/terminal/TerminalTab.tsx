// 터미널 (F-04, AC-08): worktree 경로를 cwd 로 하는 PTY + xterm 렌더.
// 이슈를 전환해도 세션이 유지되도록 열린 이슈마다 세션을 하나씩 만들어 두고 선택된 것만 보여 준다.
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import { useDeps } from '../../app/deps'
import { useUiStore } from '../../store/ui'
import { TERMINAL_EXIT_HINT, createTerminalKeyHandler } from './keys'

export type TerminalSessionSpec = { issueId: string; cwd: string }

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

  return (
    <div
      className={visible ? 'absolute inset-0 bg-[#1e1e1e]' : 'hidden'}
      data-testid="terminal-tab"
      role="region"
      aria-label={`터미널 (${TERMINAL_EXIT_HINT} 으로 나가기)`}
    >
      {sessions.filter((s) => started.has(s.issueId)).map((s) => (
        <TerminalSession key={`${s.issueId}|${s.cwd}`} spec={s} active={visible && s.issueId === activeId} onExit={onExit} />
      ))}
      {visible && !activeHasSession && (
        <p className="p-4 text-sm text-neutral-400">worktree 가 준비되면 터미널을 사용할 수 있습니다.</p>
      )}
    </div>
  )
}

function TerminalSession({ spec, active, onExit }: { spec: TerminalSessionSpec; active: boolean; onExit?: () => void }) {
  const { tauri } = useDeps()
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<{ t: Terminal; fit: FitAddon; ptyId: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 키 핸들러는 마운트 때 1회 연결하므로 최신 onExit 를 ref 로 읽는다
  const onExitRef = useRef(onExit)
  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])

  // 세션 생성: 마운트 1회. 언마운트(이슈의 worktree 삭제 등) 시 PTY 종료
  useEffect(() => {
    const el = host.current
    if (!el) return
    let disposed = false
    const t = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#1e1e1e' },
      // 출력을 스크린 리더가 읽을 수 있는 접근성 트리로도 내보낸다
      screenReaderMode: true,
    })
    t.attachCustomKeyEventHandler(createTerminalKeyHandler(() => onExitRef.current?.()))
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(el)
    const state = { t, fit, ptyId: null as string | null }
    term.current = state
    const cleanups: (() => void)[] = []

    void (async () => {
      try {
        const unlisten = await tauri.onPtyData((e) => {
          if (e.id === state.ptyId) t.write(e.data)
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
        const id = await tauri.ptySpawn({ cwd: spec.cwd, cols: Math.max(t.cols, 20), rows: Math.max(t.rows, 5) })
        if (disposed) {
          void tauri.ptyKill(id)
          return
        }
        state.ptyId = id
        useUiStore.setState((s) => ({ terminalIds: { ...s.terminalIds, [spec.issueId]: id } }))
        const sub = t.onData((d) => void tauri.ptyWrite(id, d))
        cleanups.push(() => sub.dispose())
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      disposed = true
      for (const c of cleanups) c()
      if (state.ptyId) void tauri.ptyKill(state.ptyId).catch(() => undefined)
      useUiStore.setState((s) => {
        const terminalIds = { ...s.terminalIds }
        delete terminalIds[spec.issueId]
        return { terminalIds }
      })
      t.dispose()
      term.current = null
    }
  }, [tauri, spec.cwd, spec.issueId])

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
      if (cur.ptyId) void tauri.ptyResize(cur.ptyId, cur.t.cols, cur.t.rows)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    return () => ro.disconnect()
  }, [active, tauri])

  return (
    <div className={active ? 'absolute inset-0 p-2' : 'hidden'}>
      {error && (
        <p role="alert" className="p-2 text-sm text-red-400">
          터미널을 시작할 수 없습니다: {error}
        </p>
      )}
      <div ref={host} className="size-full" />
    </div>
  )
}
