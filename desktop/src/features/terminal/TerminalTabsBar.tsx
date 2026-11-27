// Why: Radix Tabs 대신 직접 ARIA 탭 패턴을 쓴다 — 탭 줄은 터미널 영역 맨 위에, 패널은 이슈마다 따로 있어 한 Root 로 감쌀 수 없다
import { PlusIcon } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'

import { useBaseDeps } from '../../app/deps'
import { Button } from '../../components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../../components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { useHostsStore } from '../../store/hosts'
import { useUiStore } from '../../store/ui'
import { endPanes } from './endPanes'
import { isTerminalOpenKey, PANE_KEYS } from './keys'
import { leafIds, selectedTabId, tabList } from './panes'
import type { TermTab } from './panes'
import { newTerminalButtonId, tabDomIds } from './tabIds'
import type { TerminalSessionSpec } from './TerminalTab'

type Opened = { issueId: string; tabId: string; paneIds: string[] }
type Editing = Opened & { initial: string; style: CSSProperties; focusNow: boolean }

const labelOf = (t: TermTab, names: Record<string, string> | undefined) => names?.[t.id] ?? String(t.no)

// Why: 패널 id 는 다시 쓰이지 않는다 — 다른 기기가 모든 탭을 닫고 새로 열어 가상 t0 가 다시 생겨도 연 때의 탭으로 보지 않는다
function liveTab(o: Opened): TermTab | null {
  const s = useUiStore.getState()
  if (s.selectedIssueId !== o.issueId) return null
  const t = tabList(s.panes[o.issueId]?.tree ?? null).find((x) => x.id === o.tabId)
  return t && leafIds(t.node).some((p) => o.paneIds.includes(p)) ? t : null
}

const focusLost = () => document.activeElement === null || document.activeElement === document.body

export function TerminalTabsBar({ spec }: { spec: TerminalSessionSpec }) {
  const issueId = spec.issueId
  const { tauri } = useBaseDeps()
  const openKeyWorks = tauri.runtime !== 'remote'
  const tree = useUiStore((s) => s.panes[issueId]?.tree ?? null)
  const tab = useUiStore((s) => s.panes[issueId]?.tab)
  const first = useUiStore((s) => s.panes[issueId]?.first)
  const names = useUiStore((s) => s.tabNames[issueId])
  // Why: 고른 이슈가 바뀌면 다시 그려 열린 입력란·대화상자를 닫는다(아래 liveTab)
  useUiStore((s) => s.selectedIssueId)
  const tabs = useMemo(() => tabList(tree), [tree])
  const selected = selectedTabId(tree, tab)
  const [focusedTab, setFocusedTab] = useState<string | null>(null)
  const rovingTab = tabs.some((t) => t.id === focusedTab) ? focusedTab : selected
  const [editing, setEditing] = useState<Editing | null>(null)
  const [confirm, setConfirm] = useState<Opened | null>(null)
  // Why: 다른 기기가 그 탭을 지웠으면 열린 입력란·대화상자의 대상이 없다
  if (editing && !liveTab(editing)) setEditing(null)
  if (confirm && !liveTab(confirm)) setConfirm(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuFocus = useRef<(() => void) | null>(null)

  const tabButton = useCallback((tabId: string) => document.getElementById(tabDomIds(issueId, tabId).tab), [issueId])
  const focusSelected = useCallback(() => {
    const p = useUiStore.getState().panes[issueId]
    const sel = selectedTabId(p?.tree ?? null, p?.tab)
    document.getElementById(sel === null ? newTerminalButtonId(issueId) : tabDomIds(issueId, sel).tab)?.focus()
  }, [issueId])
  // Why: 닫은 뒤의 포커스는 렌더 뒤에 옮긴다 — 대화상자의 포커스 가둠이 풀리고 새로 고른 탭 버튼·[새 터미널] 이 생긴 뒤라야 한다.
  // 마지막 탭을 닫으면 이 줄이 내려가므로 정리 때 옮긴다
  const afterRender = useRef<(() => void) | null>(null)
  useEffect(() => {
    const f = afterRender.current
    afterRender.current = null
    f?.()
  })
  useEffect(() => {
    const pending = afterRender
    return () => pending.current?.()
  }, [])

  const closeNow = useCallback(
    (tabId: string): boolean | null => {
      const ui = useUiStore.getState()
      const p = ui.panes[issueId]
      const t = tabList(p?.tree ?? null).find((x) => x.id === tabId)
      if (!p || !t) return null
      // Why: closeTab 뒤에는 그 탭이 트리에 없다 — first·패널 id 를 먼저 읽는다(firstPane() 은 없으면 지금 첫 패널을 저장해 버린다)
      const firstPane = p.first
      const paneIds = leafIds(t.node)
      const wasSelected = selectedTabId(p.tree, p.tab) === tabId
      ui.closeTab(issueId, tabId)
      const probeTmux = spec.remote ? useHostsStore.getState().probes[spec.remote.host]?.tmux === true : false
      void endPanes(tauri, spec, paneIds, firstPane, probeTmux)
      return wasSelected
    },
    [issueId, spec, tauri],
  )

  const requestClose = useCallback(
    (tabId: string): 'confirm' | 'selected' | 'other' | null => {
      const t = tabList(useUiStore.getState().panes[issueId]?.tree ?? null).find((x) => x.id === tabId)
      if (!t) return null
      const paneIds = leafIds(t.node)
      if (paneIds.length === 1) return closeNow(tabId) ? 'selected' : 'other'
      setConfirm({ issueId, tabId, paneIds })
      return 'confirm'
    },
    [issueId, closeNow],
  )
  const closeFromBar = useCallback(
    (tabId: string) => {
      const hadFocus = document.activeElement === tabButton(tabId)
      const r = requestClose(tabId)
      // Why: 포커스한 버튼이 사라지면 둘 곳이 없다 — 그때와 고른 탭을 닫았을 때만 고른 탭 버튼으로 옮긴다
      if (r === 'selected' || (r === 'other' && hadFocus)) afterRender.current = focusSelected
    },
    [requestClose, focusSelected, tabButton],
  )

  const startRename = useCallback(
    (tabId: string, focusNow: boolean) => {
      const t = tabList(useUiStore.getState().panes[issueId]?.tree ?? null).find((x) => x.id === tabId)
      if (!t) return
      // Why: tablist 안에는 탭만 둔다(ARIA) — 입력란은 밖에 두고 그 탭 위에 겹친다
      const btn = tabButton(tabId)
      const style = { left: btn?.offsetLeft ?? 0, width: Math.max(btn?.offsetWidth ?? 0, 96) }
      setEditing({ issueId, tabId, paneIds: leafIds(t.node), initial: labelOf(t, useUiStore.getState().tabNames[issueId]), style, focusNow })
    },
    [issueId, tabButton],
  )

  const select = useCallback((tabId: string) => useUiStore.getState().selectTab(issueId, tabId), [issueId])

  // Why: 화살표는 포커스만 옮긴다(수동 활성) — 화살표만으로 늦게 마운트하는 탭의 셸을 만들지 않게
  const onTabKeyDown = useCallback(
    (e: ReactKeyboardEvent, tabId: string) => {
      const ids = tabList(useUiStore.getState().panes[issueId]?.tree ?? null).map((t) => t.id)
      const i = ids.indexOf(tabId)
      const move = { ArrowRight: ids[(i + 1) % ids.length], ArrowLeft: ids[(i - 1 + ids.length) % ids.length], Home: ids[0], End: ids.at(-1) }[e.key]
      if (move !== undefined) {
        e.preventDefault()
        setFocusedTab(move)
        tabButton(move)?.focus()
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        select(tabId)
      } else if (e.key === 'F2') {
        e.preventDefault()
        startRename(tabId, true)
      } else if (e.key === 'Delete') {
        e.preventDefault()
        closeFromBar(tabId)
      }
    },
    [issueId, closeFromBar, select, startRename, tabButton],
  )

  const onMenuRename = useCallback(
    (tabId: string) => {
      // Why: 메뉴가 닫히며 포커스를 돌려줄 때 입력란으로 옮긴다 — 그 전에 옮기면 메뉴의 포커스 가둠이 되찾아 입력란이 blur 로 닫힌다
      startRename(tabId, false)
      menuFocus.current = () => inputRef.current?.focus()
    },
    [startRename],
  )
  const menuPrev = useRef<Element | null>(null)
  const onMenuOpenChange = useCallback((open: boolean) => {
    if (open) menuPrev.current = document.activeElement
  }, [])
  const onMenuClose = useCallback(
    (tabId: string) => {
      const prev = menuPrev.current
      const r = requestClose(tabId)
      // Why: 메뉴 전 포커스가 남아 있으면 그대로 둔다 — 고른 탭을 닫았거나 그 요소가 사라졌으면 고른 탭 버튼으로
      menuFocus.current =
        r === 'confirm' ? () => undefined : () => (r === 'other' && prev instanceof HTMLElement && prev.isConnected ? prev.focus() : focusSelected())
    },
    [requestClose, focusSelected],
  )
  const onMenuCloseAutoFocus = useCallback((e: Event) => {
    const f = menuFocus.current
    menuFocus.current = null
    // Why: 아무것도 고르지 않고 닫으면 Radix 기본(메뉴 전 포커스로)에 맡긴다
    if (!f) return
    e.preventDefault()
    f()
  }, [])

  const finishRename = (value: string | null, focusTab: boolean) => {
    const ed = editing
    setEditing(null)
    if (!ed) return
    if (value !== null && liveTab(ed)) useUiStore.getState().renameTab(issueId, ed.tabId, value)
    if (focusTab) tabButton(ed.tabId)?.focus()
  }

  const confirmTab = confirm ? liveTab(confirm) : null
  const confirmPanes = confirmTab ? leafIds(confirmTab.node) : []
  const cancelConfirm = () => {
    const tabId = confirm?.tabId
    setConfirm(null)
    afterRender.current = () => (tabId !== undefined ? tabButton(tabId)?.focus() : undefined)
  }
  const confirmClose = () => {
    const tabId = confirm && liveTab(confirm) ? confirm.tabId : null
    setConfirm(null)
    // Why: 연 뒤에 분할됐을 수 있다 — closeNow 가 [닫기] 를 누른 때의 패널을 끝낸다
    if (tabId !== null) closeNow(tabId)
    afterRender.current = focusSelected
  }

  return (
    <div className="relative flex shrink-0 items-end gap-1 overflow-x-auto px-2 pt-1">
      <div role="tablist" aria-label="터미널 탭" className="flex items-end gap-1">
        {tabs.map((t) => (
          <TabButton
            key={t.id}
            issueId={issueId}
            tab={t}
            label={labelOf(t, names)}
            selected={t.id === selected}
            tabbable={t.id === rovingTab}
            onSelect={select}
            onKeyDown={onTabKeyDown}
            onFocusTab={setFocusedTab}
            onClose={closeFromBar}
            onRename={startRename}
            onMenuOpenChange={onMenuOpenChange}
            onMenuRename={onMenuRename}
            onMenuClose={onMenuClose}
            onMenuCloseAutoFocus={onMenuCloseAutoFocus}
          />
        ))}
      </div>
      <button
        type="button"
        aria-label="새 터미널 탭"
        title={openKeyWorks ? `새 터미널 탭 (${PANE_KEYS.open})` : '새 터미널 탭'}
        onClick={() => useUiStore.getState().newTab(issueId)}
        className="mb-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded text-neutral-400 outline-none hover:bg-neutral-800 hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PlusIcon className="size-4" aria-hidden />
      </button>
      {editing && (
        <TabNameInput
          key={editing.tabId}
          initial={editing.initial}
          style={editing.style}
          focusNow={editing.focusNow}
          inputRef={inputRef}
          onDone={finishRename}
        />
      )}
      <Dialog open={confirmTab !== null} onOpenChange={(o) => !o && cancelConfirm()}>
        <DialogContent
          className="sm:max-w-md"
          showCloseButton={false}
          // Why: 포커스는 afterRender 가 옮겼다 — Radix 가 늦게(setTimeout) 다른 곳으로 옮기지 않게 막는다
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            if (focusLost()) focusSelected()
          }}
        >
          <DialogHeader>
            <DialogTitle>터미널 탭 닫기</DialogTitle>
            <DialogDescription>
              {confirmTab ? labelOf(confirmTab, names) : ''} 탭의 터미널 {confirmPanes.length}개를 모두 닫습니다. 실행 중인 프로그램도 끝납니다.
              {spec.remote?.tmux && first !== undefined && confirmPanes.includes(first) && ' 원격 기본 tmux 세션은 남습니다.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={cancelConfirm}>
              취소
            </Button>
            <Button type="button" variant="destructive" onClick={confirmClose}>
              닫기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

type TabButtonProps = {
  issueId: string
  tab: TermTab
  label: string
  selected: boolean
  tabbable: boolean
  onSelect(tabId: string): void
  onKeyDown(e: ReactKeyboardEvent, tabId: string): void
  onFocusTab(tabId: string): void
  onClose(tabId: string): void
  onRename(tabId: string, focusNow: boolean): void
  onMenuOpenChange(open: boolean): void
  onMenuRename(tabId: string): void
  onMenuClose(tabId: string): void
  onMenuCloseAutoFocus(e: Event): void
}

const TabButton = memo(function TabButton({
  issueId,
  tab,
  label,
  selected,
  tabbable,
  onSelect,
  onKeyDown,
  onFocusTab,
  onClose,
  onRename,
  onMenuOpenChange,
  onMenuRename,
  onMenuClose,
  onMenuCloseAutoFocus,
}: TabButtonProps) {
  const ids = tabDomIds(issueId, tab.id)
  return (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <ContextMenuTrigger asChild>
        {/* Why: 스타일은 data-state 가 아니라 aria-selected 로 — ContextMenuTrigger 가 data-state 를 덮는다.
            색은 테마가 아니라 고정 색 — 라이트 테마도 터미널 배경은 어둡다 */}
        <button
          type="button"
          role="tab"
          id={ids.tab}
          aria-selected={selected}
          aria-controls={ids.panel}
          tabIndex={tabbable ? 0 : -1}
          onClick={() => onSelect(tab.id)}
          onDoubleClick={() => onRename(tab.id, true)}
          onKeyDown={(e) => onKeyDown(e, tab.id)}
          onFocus={() => onFocusTab(tab.id)}
          className="flex h-7 shrink-0 items-center gap-0.5 rounded-t border-b-2 border-transparent pl-2.5 text-xs whitespace-nowrap text-neutral-400 outline-none hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-selected:border-neutral-100 aria-selected:bg-neutral-700 aria-selected:text-neutral-100"
        >
          <span className="sr-only">터미널 </span>
          {/* Why: 이름 쪽이 × 보다 넓어야 탭 가운데를 누를 때 닫히지 않고 고른다("1" 만으로는 가운데가 × 위다) */}
          <span className="min-w-8 text-center">{label}</span>
          {/* Why: 포커스 안 되는 표시(키보드는 Delete). mouseDown 을 막아 고르지 않은 탭을 닫아도 포커스·선택이 그대로다 */}
          <span
            aria-hidden
            onMouseDown={(e) => {
              e.stopPropagation()
              e.preventDefault()
            }}
            onClick={(e) => {
              e.stopPropagation()
              onClose(tab.id)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="inline-flex size-6 items-center justify-center rounded hover:bg-neutral-600"
          >
            ×
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={onMenuCloseAutoFocus}>
        <ContextMenuItem onSelect={() => onMenuRename(tab.id)}>이름 바꾸기 (F2)</ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => onMenuClose(tab.id)}>
          탭 닫기 (Delete)
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

type TabNameInputProps = {
  initial: string
  style: CSSProperties
  focusNow: boolean
  inputRef: RefObject<HTMLInputElement | null>
  onDone(value: string | null, focusTab: boolean): void
}

function TabNameInput({ initial, style, focusNow, inputRef, onDone }: TabNameInputProps) {
  const [value, setValue] = useState(initial)
  // Why: Enter·Esc 뒤 탭 버튼으로 포커스를 옮길 때 오는 blur 로 다시 저장하지 않게
  const done = useRef(false)
  const finish = (v: string | null, focusTab: boolean) => {
    if (done.current) return
    done.current = true
    onDone(v, focusTab)
  }
  useEffect(() => {
    if (!focusNow) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusNow, inputRef])
  return (
    <Input
      ref={inputRef}
      aria-label="탭 이름"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value, false)}
      onKeyDown={(e) => {
        // Why: 입력 중의 키가 탭 줄·window 단축키(Ctrl+T 새 탭)로 가지 않게
        e.stopPropagation()
        if (isTerminalOpenKey(e.nativeEvent)) return e.preventDefault()
        // Why: 조합 중의 Enter·Esc 는 조합을 끝내는 키다(WebView2 는 그 Enter 를 229 로 한 번 더 보낸다)
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(value, true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(null, true)
        }
      }}
      style={style}
      className="absolute bottom-0 z-10 h-7 rounded-t rounded-b-none border-neutral-600 bg-neutral-900 px-2 text-xs text-neutral-100"
    />
  )
}
