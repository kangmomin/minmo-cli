// 사이드바 폭 조절 구분선 (#70) — 끌기·키보드·더블클릭, 저장 시점
// jsdom 26 에는 PointerEvent·pointer capture 가 없다 → 포인터는 user-event 14(user.pointer·user.dblClick)가 만든 대체 이벤트를 쓰고,
// user-event 가 만들 수 없는 이벤트(pointercancel·lostpointercapture·buttons=0 move)만 ptr() 로 보낸다
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

import { TooltipProvider } from '../../components/ui/tooltip'
import { useUiStore } from '../../store/ui'
import { makeDeps, renderWithDeps } from '../../test/render'
import { Sidebar } from './Sidebar'
import { SidebarFrame } from './SidebarFrame'

let setItemSpy: MockInstance<Storage['setItem']>
/** minmo-ui 에 쓴 횟수 */
const saves = () => setItemSpy.mock.calls.filter(([key]) => key === 'minmo-ui').length
const stored = () => useUiStore.getState().sidebarWidth

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState({ sidebarWidth: 288 })
  // setState 도 localStorage 에 쓴다 — 기준점은 그 뒤
  setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
})

/** 시작 폭을 바꾸고 setItem 기준점을 다시 잡는다 */
function startAt(width: number) {
  useUiStore.setState({ sidebarWidth: width })
  setItemSpy.mockClear()
}

function renderFrame() {
  const view = render(
    <SidebarFrame>
      <div />
    </SidebarFrame>,
  )
  const sep = screen.getByRole('separator', { name: '사이드바 폭' })
  const aside = screen.getByRole('complementary', { name: '이슈 트리' })
  // user-event 가 보낸 pointerdown 의 pointerId — ptr() 로 같은 포인터의 종료 이벤트를 보낼 때 쓴다
  const downIds: number[] = []
  sep.addEventListener('pointerdown', (e) => downIds.push((e as PointerEvent).pointerId))
  const dblclick = vi.fn()
  sep.addEventListener('dblclick', dblclick)
  const width = () => aside.style.getPropertyValue('--sidebar-w')
  return { ...view, sep, aside, width, downIds, dblclick, user: userEvent.setup() }
}

/** user-event 가 만들 수 없는 포인터 이벤트를 보낸다(MouseEvent + pointerId·isPrimary) */
function ptr(target: Element, type: string, init: MouseEventInit & { pointerId: number; isPrimary?: boolean }) {
  const { pointerId, isPrimary = true, ...rest } = init
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...rest })
  Object.defineProperty(e, 'pointerId', { value: pointerId })
  Object.defineProperty(e, 'isPrimary', { value: isPrimary })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}

describe('AC-04 구분선을 끌면 폭이 바뀐다', () => {
  it('드래그 중에는 화면(--sidebar-w)만 바뀌고 저장하지 않는다 → 놓을 때 한 번 저장한다', async () => {
    const { sep, width, user } = renderFrame()
    expect(width()).toBe('288px')
    await user.pointer([{ keys: '[MouseLeft>]', target: sep, coords: { clientX: 100 } }, { coords: { clientX: 150 } }])
    expect(width()).toBe('338px')
    expect(stored()).toBe(288)
    expect(saves()).toBe(0)
    await user.pointer({ keys: '[/MouseLeft]' })
    expect(stored()).toBe(338)
    expect(width()).toBe('338px')
    expect(saves()).toBe(1)
  })
})

describe('EC-04 드래그 중 범위 밖으로 끌면 최소·최대에서 멈춘다', () => {
  it('왼쪽 끝 240, 오른쪽 끝 480', async () => {
    const { sep, width, user } = renderFrame()
    await user.pointer([{ keys: '[MouseLeft>]', target: sep, coords: { clientX: 500 } }, { coords: { clientX: 0 } }])
    expect(width()).toBe('240px')
    await user.pointer({ coords: { clientX: 1500 } })
    expect(width()).toBe('480px')
    await user.pointer({ keys: '[/MouseLeft]' })
    expect(stored()).toBe(480)
    expect(saves()).toBe(1)
  })
})

describe('EC-05 드래그 시작·종료 조건', () => {
  it.each([
    ['버튼이 눌리지 않은 pointermove(buttons=0)', (sep: Element, pointerId: number) => ptr(sep, 'pointermove', { pointerId, buttons: 0, clientX: 160 })],
    ['pointercancel', (sep: Element, pointerId: number) => ptr(sep, 'pointercancel', { pointerId })],
    ['lostpointercapture', (sep: Element, pointerId: number) => ptr(sep, 'lostpointercapture', { pointerId })],
  ])('%s 에서 끝내고 마지막 값을 1회 저장한다 · 그 뒤의 move·pointerup 은 무시한다', async (_name, finish) => {
    const { sep, width, downIds, user } = renderFrame()
    await user.pointer([{ keys: '[MouseLeft>]', target: sep, coords: { clientX: 100 } }, { coords: { clientX: 150 } }])
    expect(sep).toHaveAttribute('data-dragging')
    expect(downIds).toHaveLength(1)
    finish(sep, downIds[0])
    expect(sep).not.toHaveAttribute('data-dragging')
    expect(stored()).toBe(338)
    expect(saves()).toBe(1)
    // 이미 끝난 드래그 — 같은 포인터의 이후 이벤트는 무시한다(멱등)
    await user.pointer([{ coords: { clientX: 200 } }, { keys: '[/MouseLeft]' }])
    expect(width()).toBe('338px')
    expect(stored()).toBe(338)
    expect(saves()).toBe(1)
  })

  it('왼쪽 버튼으로 누르면 기본 동작(텍스트 선택)을 막는다', () => {
    const { sep } = renderFrame()
    // 단독 pointerdown — 뒤따르는 이벤트와 맞출 id 가 없어 임의의 값을 쓴다
    const e = ptr(sep, 'pointerdown', { pointerId: 1, button: 0, buttons: 1, isPrimary: true, clientX: 100 })
    expect(e.defaultPrevented).toBe(true)
  })

  it('오른쪽 버튼으로는 시작하지 않는다(기본 동작도 막지 않는다)', async () => {
    const { sep, width, user } = renderFrame()
    const mousedown = vi.fn()
    sep.addEventListener('mousedown', mousedown)
    await user.pointer([{ keys: '[MouseRight>]', target: sep, coords: { clientX: 100 } }, { coords: { clientX: 200 } }, { keys: '[/MouseRight]' }])
    // pointerdown 을 막으면 user-event 는 mousedown 을 보내지 않는다
    expect(mousedown).toHaveBeenCalled()
    expect(width()).toBe('288px')
    expect(stored()).toBe(288)
    expect(saves()).toBe(0)
  })

  it('주 포인터가 아닌 포인터(두 번째 터치)로는 폭을 바꾸지 않는다', async () => {
    const { sep, width, user } = renderFrame()
    await user.pointer([
      { keys: '[TouchA>]', target: sep, coords: { clientX: 100 } },
      { keys: '[TouchB>]', target: sep, coords: { clientX: 100 } },
      { pointerName: 'TouchB', coords: { clientX: 150 } },
    ])
    expect(width()).toBe('288px')
    await user.pointer([{ keys: '[/TouchB]' }, { keys: '[/TouchA]' }])
    expect(stored()).toBe(288)
    expect(saves()).toBe(0)
  })

  it('드래그 중 키 입력은 무시한다', async () => {
    const { sep, width, user } = renderFrame()
    act(() => sep.focus())
    await user.pointer([{ keys: '[MouseLeft>]', target: sep, coords: { clientX: 100 } }, { coords: { clientX: 150 } }])
    await user.keyboard('{End}')
    expect(width()).toBe('338px')
    expect(stored()).toBe(288)
    expect(saves()).toBe(0)
    await user.pointer({ keys: '[/MouseLeft]' })
    expect(stored()).toBe(338)
    expect(saves()).toBe(1)
  })

  it('드래그 중 unmount 되면 저장하지 않는다(store 의 값 유지)', async () => {
    const { sep, width, user, unmount } = renderFrame()
    await user.pointer([{ keys: '[MouseLeft>]', target: sep, coords: { clientX: 100 } }, { coords: { clientX: 150 } }])
    expect(width()).toBe('338px')
    unmount()
    expect(stored()).toBe(288)
    expect(saves()).toBe(0)
  })
})

describe('AC-09 움직이지 않은 클릭은 폭을 바꾸지 않고 저장하지 않는다', () => {
  it('키보드(End)로 바꾼 뒤의 클릭 → 480 유지, 저장은 End 의 1회뿐', async () => {
    const { sep, width, user } = renderFrame()
    act(() => sep.focus())
    await user.keyboard('{End}')
    expect(stored()).toBe(480)
    await user.click(sep)
    expect(width()).toBe('480px')
    expect(stored()).toBe(480)
    expect(saves()).toBe(1)
  })

  it('드래그(400) → 더블클릭(288) 뒤의 클릭 → 288 유지', async () => {
    const { sep, width, user } = renderFrame()
    await user.pointer([{ keys: '[MouseLeft>]', target: sep, coords: { clientX: 100 } }, { coords: { clientX: 212 } }, { keys: '[/MouseLeft]' }])
    expect(stored()).toBe(400)
    await user.dblClick(sep)
    expect(stored()).toBe(288)
    const before = saves()
    await user.click(sep)
    expect(width()).toBe('288px')
    expect(stored()).toBe(288)
    expect(saves()).toBe(before)
  })

  it('3px 보다 작게(2px) 움직이고 놓으면 폭이 그대로이고 저장하지 않는다', async () => {
    const { sep, width, user } = renderFrame()
    await user.pointer([{ keys: '[MouseLeft>]', target: sep, coords: { clientX: 100 } }, { coords: { clientX: 102 } }, { keys: '[/MouseLeft]' }])
    expect(width()).toBe('288px')
    expect(stored()).toBe(288)
    expect(saves()).toBe(0)
  })
})

describe('AC-08 구분선을 더블클릭하면 기본 폭(288)으로 돌아간다', () => {
  it('더블클릭 → 288 저장', async () => {
    startAt(400)
    const { sep, width, user } = renderFrame()
    expect(width()).toBe('400px')
    await user.dblClick(sep)
    expect(width()).toBe('288px')
    expect(stored()).toBe(288)
    expect(saves()).toBe(1)
  })

  it('1~2px 떨림이 있는 더블클릭도 리셋으로 본다', async () => {
    startAt(400)
    const { sep, dblclick, user } = renderFrame()
    // 클릭 횟수는 user.pointer 호출이 끝나면 초기화된다 → 한 호출 안에서 두 번 누른다
    await user.pointer([
      { keys: '[MouseLeft>]', target: sep, coords: { clientX: 100 } },
      { coords: { clientX: 101 } },
      { keys: '[/MouseLeft]' },
      { keys: '[MouseLeft>]', coords: { clientX: 101 } },
      { coords: { clientX: 103 } },
      { keys: '[/MouseLeft]' },
    ])
    expect(dblclick).toHaveBeenCalledTimes(1)
    expect(stored()).toBe(288)
    expect(saves()).toBe(1)
  })

  it('바로 앞의 조작이 끌기였으면 더블클릭을 무시한다(빠른 두 번 끌기)', async () => {
    startAt(400)
    const { sep, width, dblclick, user } = renderFrame()
    await user.pointer([
      { keys: '[MouseLeft>]', target: sep, coords: { clientX: 100 } },
      { coords: { clientX: 110 } },
      { keys: '[/MouseLeft]' },
      { keys: '[MouseLeft>]', coords: { clientX: 110 } },
      { coords: { clientX: 120 } },
      { keys: '[/MouseLeft]' },
    ])
    // dblclick 자체는 발생했다 — 그래도 리셋하지 않는다
    expect(dblclick).toHaveBeenCalledTimes(1)
    expect(width()).toBe('420px')
    expect(stored()).toBe(420)
  })
})

describe('AC-05 구분선은 ARIA window splitter 다', () => {
  it('role·이름·aria-* 와 Tab 포커스', async () => {
    const { sep, aside, user } = renderFrame()
    expect(sep).toHaveAttribute('aria-orientation', 'vertical')
    expect(sep).toHaveAttribute('aria-valuenow', '288')
    expect(sep).toHaveAttribute('aria-valuemin', '240')
    expect(sep).toHaveAttribute('aria-valuemax', '480')
    expect(sep).toHaveAttribute('aria-valuetext', '288픽셀')
    expect(aside.id).not.toBe('')
    expect(sep).toHaveAttribute('aria-controls', aside.id)
    expect(sep).toHaveAttribute('tabindex', '0')
    await user.tab()
    expect(sep).toHaveFocus()
  })

  it('←/→ 는 16px, Home 은 최소, End 는 최대 — 바로 저장한다', async () => {
    const { sep, width, user } = renderFrame()
    await user.tab()
    await user.keyboard('{ArrowRight}')
    expect(stored()).toBe(304)
    expect(sep).toHaveAttribute('aria-valuenow', '304')
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(stored()).toBe(272)
    await user.keyboard('{Home}')
    expect(stored()).toBe(240)
    expect(width()).toBe('240px')
    await user.keyboard('{End}')
    expect(stored()).toBe(480)
    expect(sep).toHaveAttribute('aria-valuetext', '480픽셀')
    // 값이 바뀐 키 입력 5번(→ ← ← Home End)마다 1회씩 저장한다
    expect(saves()).toBe(5)
  })

  it('Ctrl·Alt·Meta 와 함께 누르면 무시한다', async () => {
    const { sep, user } = renderFrame()
    await user.tab()
    await user.keyboard('{Control>}{ArrowRight}{End}{/Control}')
    await user.keyboard('{Alt>}{ArrowLeft}{Home}{/Alt}')
    await user.keyboard('{Meta>}{ArrowRight}{End}{/Meta}')
    expect(stored()).toBe(288)
    expect(sep).toHaveAttribute('aria-valuenow', '288')
    expect(saves()).toBe(0)
  })

  it.each([
    [240, '{Home}{ArrowLeft}'],
    [480, '{End}{ArrowRight}'],
  ])('범위 끝(%i)에서는 값이 바뀌지 않고 저장하지 않는다', async (edge, keys) => {
    startAt(edge)
    const { sep, user } = renderFrame()
    await user.tab()
    await user.keyboard(keys)
    expect(stored()).toBe(edge)
    expect(sep).toHaveAttribute('aria-valuenow', String(edge))
    expect(saves()).toBe(0)
  })

  it('Sidebar 의 구분선은 "이슈 트리" aside 를 가리킨다(aria-controls)', () => {
    renderWithDeps(
      <TooltipProvider>
        <Sidebar onOpenSettings={() => {}} />
      </TooltipProvider>,
      makeDeps(),
    )
    const sep = screen.getByRole('separator', { name: '사이드바 폭' })
    const aside = screen.getByRole('complementary', { name: '이슈 트리' })
    expect(aside.id).not.toBe('')
    expect(sep).toHaveAttribute('aria-controls', aside.id)
  })
})

describe('EC-01 손상·범위 밖 저장 값의 표시 정합', () => {
  it.each([
    [1000, 480],
    [100, 240],
    ['300', 288],
  ])('저장 값 %j → aria-valuenow·--sidebar-w·store 가 모두 %i', async (saved, expected) => {
    localStorage.setItem('minmo-ui', JSON.stringify({ state: { sidebarWidth: saved }, version: 1 }))
    await useUiStore.persist.rehydrate()
    const { sep, width } = renderFrame()
    expect(stored()).toBe(expected)
    expect(sep).toHaveAttribute('aria-valuenow', String(expected))
    expect(width()).toBe(`${expected}px`)
  })
})
