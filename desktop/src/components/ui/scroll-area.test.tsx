// 사이드바 목록이 사이드바보다 넓어지지 않게 (#70) — 내용 칸이 Radix 기본 display:table 이 아니어야 한다
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ScrollArea } from './scroll-area'

describe('ScrollArea 내용 칸 (AC-01·AC-03)', () => {
  it('viewport 의 직계 자식이 내용을 담고 display:block 이다', () => {
    render(
      <ScrollArea>
        <div>긴 이름이 들어 있는 목록</div>
      </ScrollArea>,
    )
    const viewport = document.querySelector('[data-radix-scroll-area-viewport]')
    const content = viewport?.firstElementChild as HTMLElement | null | undefined
    expect(content).toBeTruthy()
    expect(content).toContainElement(screen.getByText('긴 이름이 들어 있는 목록'))
    expect(content!.style.display).toBe('block')
  })
})
