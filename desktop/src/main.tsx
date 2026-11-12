import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { RemoteGate } from './features/remote/RemoteGate'
import { runtimeKind } from './lib/tauri'
import './index.css'
import { applyTheme } from './lib/theme'
import { useUiStore } from './store/ui'

// 첫 렌더 전에 저장된 테마를 적용해 라이트 사용자에게 검은 화면이 깜박이지 않게 한다
applyTheme(useUiStore.getState().theme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 다른 기기의 브라우저로 연 화면은 먼저 호스트에 붙는다(처음이면 기기 등록) */}
    {runtimeKind() === 'remote' ? (
      <RemoteGate>
        <App />
      </RemoteGate>
    ) : (
      <App />
    )}
  </StrictMode>,
)
