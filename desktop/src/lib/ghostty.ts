// Ghostty 터미널의 기본 색(테마를 정하지 않았을 때) — ghostty 소스의 src/config/Config.zig(배경·글자)와
// src/terminal/color.zig(Name.default, 16색)에서 가져왔다. 앱 화면 토큰(index.css 의 .ghostty)도 이 색을 따른다.
import type { ITheme } from '@xterm/xterm'

export const GHOSTTY = {
  background: '#282c34',
  foreground: '#ffffff',
  /** 0~7: black red green yellow blue magenta cyan white · 8~15: 밝은 쪽 */
  palette: [
    '#1d1f21',
    '#cc6666',
    '#b5bd68',
    '#f0c674',
    '#81a2be',
    '#b294bb',
    '#8abeb7',
    '#c5c8c6',
    '#666666',
    '#d54e53',
    '#b9ca4a',
    '#e7c547',
    '#7aa6da',
    '#c397d8',
    '#70c0b1',
    '#eaeaea',
  ],
} as const

const [black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = GHOSTTY.palette

/** 이름으로 쓰는 팔레트(편집기 문법 강조 등) */
export const GHOSTTY_COLORS = { black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite }

/** xterm 테마. Ghostty 는 커서·선택 색을 따로 두지 않는다 — 커서는 글자색, 선택은 글자·배경을 뒤집는다 */
export const GHOSTTY_TERMINAL: ITheme = {
  background: GHOSTTY.background,
  foreground: GHOSTTY.foreground,
  cursor: GHOSTTY.foreground,
  cursorAccent: GHOSTTY.background,
  selectionBackground: GHOSTTY.foreground,
  selectionForeground: GHOSTTY.background,
  black,
  red,
  green,
  yellow,
  blue,
  magenta,
  cyan,
  white,
  brightBlack,
  brightRed,
  brightGreen,
  brightYellow,
  brightBlue,
  brightMagenta,
  brightCyan,
  brightWhite,
}

/**
 * 앱 화면용으로 더한 색 — Ghostty 에는 없는 면·보조 글자 색을 배경(#282c34) 계열에서 정했다.
 * index.css 의 .ghostty 토큰과 같은 값이어야 한다(테스트가 대비를 확인한다).
 */
export const GHOSTTY_UI = {
  surface: '#2f343d',
  raised: '#363c47',
  /** 보조 글자 — 팔레트의 밝은 검정(#666666)은 배경 위 대비가 낮아 글자에는 쓰지 않는다 */
  mutedForeground: '#abb2bf',
  /** 편집기 주석 */
  comment: '#9299a5',
  accent: blue,
  /** 오류 글자 — 팔레트 빨강(#cc6666)을 배경 위에서 읽히도록 밝힌 값 */
  error: '#e27878',
  accentForeground: black,
} as const
