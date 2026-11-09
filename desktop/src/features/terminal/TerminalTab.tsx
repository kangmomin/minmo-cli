// 터미널 (F-04, AC-08): worktree 경로를 cwd 로 하는 PTY + xterm 렌더.
// 이슈를 전환해도 세션이 유지되도록 열린 이슈마다 세션을 하나씩 만들어 두고 선택된 것만 보여 준다.
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import { useDeps } from '../../app/deps'
import { useUiStore } from '../../store/ui'

export type TerminalSessionSpec = { issueId: string; cwd: string }

export interface TerminalTabProps {
  /** 세션을 유지할 이슈들(worktree 준비 완료) */
  sessions: TerminalSessionSpec[]
  activeId: string | null
  /** 터미널 탭이 선택되어 있는가 */
  visible: boolean
}

export function TerminalTab({ sessions, activeId, visible }: TerminalTabProps) {
  const activeHasSession = sessions.some((s) => s.issueId === activeId)
  // PTY 는 터미널 탭에서 처음 볼 때 만들고, 이후에는 이슈를 전환해도 유지한다
  const [started, setStarted] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (visible && activeId && activeHasSession && !started.has(activeId)) setStarted((s) => new Set(s).add(activeId))
  }, [visible, activeId, activeHasSession, started])

  return (
    <div className={visible ? 'absolute inset-0 bg-[#1e1e1e]' : 'hidden'} data-testid="terminal-tab">
      {sessions.filter((s) => started.has(s.issueId)).map((s) => (
        <TerminalSession key={`${s.issueId}|${s.cwd}`} spec={s} active={visible && s.issueId === activeId} />
      ))}
      {visible && !activeHasSession && (
        <p className="p-4 text-sm text-neutral-400">worktree 가 준비되면 터미널을 사용할 수 있습니다.</p>
      )}
    </div>
  )
}

function TerminalSession({ spec, active }: { spec: TerminalSessionSpec; active: boolean }) {
  const { tauri } = useDeps()
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<{ t: Terminal; fit: FitAddon; ptyId: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    })
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
        setError(e instanceof Error ? e.message : String(e))
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

  // 표시·리사이즈 시 크기 맞추고 PTY 에 전달
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
    term.current?.t.focus()
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    return () => ro.disconnect()
  }, [active, tauri])

  return (
    <div className={active ? 'absolute inset-0 p-2' : 'hidden'}>
      {error && <p className="p-2 text-sm text-red-400">터미널을 시작할 수 없습니다: {error}</p>}
      <div ref={host} className="size-full" />
    </div>
  )
}
