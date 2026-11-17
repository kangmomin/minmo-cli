import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom 에 없는 브라우저 API — Radix(shadcn) 컴포넌트가 사용
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// jsdom 에는 canvas 가 없다 — 불러올 때 canvas 를 찾는 xterm WebGL 렌더러가 "Not implemented" 를 찍지 않게 "없음"(null)으로 답한다
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext

afterEach(() => {
  cleanup()
})
