// 포커스 표시 대비 (AX-22, WCAG 1.4.11 비텍스트 대비 3:1) — 테마 변수는 무채색 oklch 라 상대 휘도 Y = L^3
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const css = read('./index.css')

function themeBlock(selector: string): string {
  const m = new RegExp(String.raw`${selector}\s*\{([^}]*)\}`).exec(css)
  if (!m) throw new Error(`${selector} 블록 없음`)
  return m[1]
}

function lightness(block: string, name: string): number {
  const m = new RegExp(String.raw`--${name}:\s*oklch\(([\d.]+) 0 0\)`).exec(block)
  if (!m) throw new Error(`--${name} 가 무채색 oklch 가 아님`)
  return Number(m[1])
}

const luminance = (l: number) => l ** 3
const contrast = (a: number, b: number) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe.each([
  ['라이트', ':root'],
  ['다크', String.raw`\.dark`],
])('AX-22 %s 테마: --ring 은 인접 배경 대비 3:1 이상', (_name, selector) => {
  const block = themeBlock(selector)
  it.each(['background', 'card', 'muted', 'accent'])('--ring vs --%s', (surface) => {
    expect(contrast(lightness(block, 'ring'), lightness(block, surface))).toBeGreaterThanOrEqual(3)
  })
})

describe('AX-22 포커스 스타일에 반투명(/50) ring·outline 을 쓰지 않는다', () => {
  it('전역 base 는 outline-ring (알파 없음)', () => {
    expect(css).toMatch(/@apply[^;]*\boutline-ring\s*;/)
    expect(css).not.toMatch(/outline-ring\/\d+/)
  })

  it.each(['./components/ui/button.tsx', './components/ui/tabs.tsx', './components/ui/radio-group.tsx'])('%s 의 focus-visible ring', (file) => {
    const src = read(file)
    expect(src).toContain('focus-visible:ring-ring')
    expect(src).not.toMatch(/focus-visible:ring-ring\/\d+/)
  })
})
