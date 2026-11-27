// 포커스 표시 대비 (AX-22, WCAG 1.4.11 비텍스트 대비 3:1) — 테마 변수는 무채색 oklch 라 상대 휘도 Y = L^3
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import colors from 'tailwindcss/colors'

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

  it.each([
    './components/ui/button.tsx',
    './components/ui/tabs.tsx',
    './components/ui/radio-group.tsx',
    './components/ui/input.tsx',
    './components/ui/textarea.tsx',
    // AX-40 사이드바 폭 구분선
    './features/tree/SidebarFrame.tsx',
  ])('%s 의 focus-visible ring', (file) => {
    const src = read(file)
    expect(src).toContain('focus-visible:ring-ring')
    expect(src).not.toMatch(/focus-visible:ring-ring\/\d+/)
  })

  // AX-40: 구분선은 폭이 좁아(6px) ring 만으로는 잘 안 보인다 — 배경도 불투명 ring 색으로 칠한다
  it('./features/tree/SidebarFrame.tsx 의 구분선 포커스 강조는 불투명 bg-ring', () => {
    const src = read('./features/tree/SidebarFrame.tsx')
    expect(src).toContain('focus-visible:bg-ring')
    expect(src).not.toMatch(/bg-ring\/\d+/)
  })

  // 메뉴 항목은 배경(accent)만으로 강조하면 대비가 부족하다 — 불투명 ring 을 함께 쓴다(AX-38)
  it('./components/ui/context-menu.tsx 의 ContextMenuItem 포커스 강조는 불투명 ring', () => {
    const src = read('./components/ui/context-menu.tsx')
    expect(src).toContain('focus:ring-2')
    expect(src).toContain('focus:ring-ring')
    expect(src).not.toMatch(/focus:ring-ring\/\d+/)
  })
})

describe('#122 답변 모드의 새 글자색·포커스 표시', () => {
  // Why: 채도가 있는 색은 휘도가 L^3 이 아니다 — oklab 을 거쳐 선형 sRGB 로 바꿔 잰다(sRGB 밖은 자른다).
  function oklchLuminance(value: string): number {
    const m = /oklch\(([\d.]+)(%?) ([\d.]+) ([\d.]+)\)/.exec(value)
    if (!m) throw new Error(`oklch 가 아님: ${value}`)
    const l = Number(m[1]) / (m[2] === '%' ? 100 : 1)
    const h = (Number(m[4]) * Math.PI) / 180
    const [a, b] = [Number(m[3]) * Math.cos(h), Number(m[3]) * Math.sin(h)]
    const lms = [l + 0.3963377774 * a + 0.2158037573 * b, l - 0.1055613458 * a - 0.0638541728 * b, l - 0.0894841775 * a - 1.291485548 * b].map((x) => x ** 3)
    const rgb = [
      [4.0767416621, -3.3077115913, 0.2309699292],
      [-1.2684380046, 2.6097574011, -0.3413193965],
      [-0.0041960863, -0.7034186147, 1.707614701],
    ].map((row) => Math.min(1, Math.max(0, row.reduce((sum, k, i) => sum + k * lms[i], 0))))
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
  }
  function surfaceLuminance(block: string, name: string): number {
    const hex = new RegExp(String.raw`--${name}:\s*#([0-9a-f]{6})`, 'i').exec(block)
    if (!hex) return luminance(lightness(block, name))
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

  it('EC-15 요약 카드의 "더 급한 세션" 글자는 text-amber-700 · dark:text-amber-400 이다', () => {
    expect(read('./features/answer/AnswerSummary.tsx')).toContain('text-amber-700 dark:text-amber-400')
  })

  it.each([
    ['라이트', ':root', colors.amber[700]],
    ['다크', String.raw`\.dark`, colors.amber[400]],
    ['Ghostty', String.raw`\.dark\.ghostty`, colors.amber[400]],
  ])('EC-15 %s 테마: amber 글자 vs --background·--card 대비 4.5:1 이상', (_name, selector, text) => {
    const block = themeBlock(selector)
    for (const surface of ['background', 'card']) expect(ratio(oklchLuminance(text), surfaceLuminance(block, surface)), surface).toBeGreaterThanOrEqual(4.5)
  })

  it.each(['./features/answer/AnswerSummary.tsx', './features/answer/AnswerSessionList.tsx'])('EC-15 %s 의 focus-visible ring 은 불투명 ring', (file) => {
    const src = read(file)
    expect(src).toContain('focus-visible:ring-ring')
    expect(src).not.toMatch(/focus-visible:ring-ring\/\d+/)
  })
})
