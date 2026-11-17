import { useId, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react'

import { cn } from '../../lib/utils'
import { SIDEBAR_WIDTH, clampSidebarWidth, useUiStore } from '../../store/ui'

interface SidebarFrameProps {
  className?: string
  children: ReactNode
}

/** 누른 위치에서 이만큼(px) 가로로 움직여야 끌기로 본다 — 더 작은 떨림은 클릭(더블클릭 포함)이다 */
const DRAG_THRESHOLD = 3

/**
 * 사이드바(aside)와 오른쪽 경계의 폭 조절 구분선(ARIA window splitter).
 * 폭의 주인은 store 다 — 끄는 동안에는 화면에만 반영하고 놓을 때 한 번 저장한다.
 * 트리는 children 으로 받아 끄는 동안 다시 렌더하지 않는다.
 */
export function SidebarFrame({ className, children }: SidebarFrameProps) {
  const id = useId()
  const stored = useUiStore((s) => s.sidebarWidth)
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth)
  const [draft, setDraft] = useState<number | null>(null)
  const drag = useRef<{ id: number; x: number; w: number; last: number; moved: boolean } | null>(null)
  /** 바로 앞의 포인터 조작이 끌기였는지 — 빠른 두 번 끌기를 더블클릭 리셋으로 보지 않는다 */
  const lastMoved = useRef(false)
  const width = draft ?? stored

  // 이미 끝난 드래그의 이벤트(pointerup 뒤의 lostpointercapture 등)는 무시한다 — 저장은 움직인 경우에만 1회
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    drag.current = null
    lastMoved.current = d.moved
    setDraft(null)
    if (d.moved) setSidebarWidth(d.last)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (drag.current || e.ctrlKey || e.altKey || e.metaKey) return
    const next =
      e.key === 'ArrowLeft'
        ? stored - SIDEBAR_WIDTH.step
        : e.key === 'ArrowRight'
          ? stored + SIDEBAR_WIDTH.step
          : e.key === 'Home'
            ? SIDEBAR_WIDTH.min
            : e.key === 'End'
              ? SIDEBAR_WIDTH.max
              : null
    if (next === null) return
    e.preventDefault()
    setSidebarWidth(next)
  }

  return (
    <aside
      id={id}
      aria-label="이슈 트리"
      // inline width 가 아니라 변수로 넘긴다 — 좁은 화면에서는 Workspace 의 max-md:w-full 이 이겨야 한다(EC-03)
      style={{ '--sidebar-w': `${width}px` } as CSSProperties}
      className={cn('relative flex h-full w-(--sidebar-w) shrink-0 flex-col border-r', className)}
    >
      {children}
      {/* aside 밖(main 쪽)에 두어 트리 스크롤바와 겹치지 않는다. 포커스 표시는 불투명 ring + bg-ring 강조(AX-40, AX-22) */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="사이드바 폭"
        aria-controls={id}
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_WIDTH.min}
        aria-valuemax={SIDEBAR_WIDTH.max}
        aria-valuetext={`${width}픽셀`}
        tabIndex={0}
        data-dragging={draft !== null ? '' : undefined}
        className="absolute inset-y-0 left-full z-10 w-1.5 cursor-col-resize touch-none select-none outline-none hover:bg-ring data-[dragging]:bg-ring focus-visible:bg-ring focus-visible:ring-2 focus-visible:ring-ring max-md:hidden"
        onPointerDown={(e) => {
          if (e.button !== 0 || !e.isPrimary) return
          // 끄는 동안 글자가 선택되지 않게 — 그래서 마우스로 눌러도 포커스는 가지 않는다(키보드는 Tab)
          e.preventDefault()
          e.currentTarget.setPointerCapture?.(e.pointerId)
          drag.current = { id: e.pointerId, x: e.clientX, w: stored, last: stored, moved: false }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d || e.pointerId !== d.id) return
          // 창 밖에서 버튼을 놓아 pointerup 을 놓친 경우
          if ((e.buttons & 1) === 0) return end(e)
          const dx = e.clientX - d.x
          if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD) return
          d.moved = true
          d.last = clampSidebarWidth(d.w + dx)
          setDraft(d.last)
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onKeyDown={onKeyDown}
        onDoubleClick={() => {
          if (!lastMoved.current) setSidebarWidth(SIDEBAR_WIDTH.default)
        }}
      />
    </aside>
  )
}
