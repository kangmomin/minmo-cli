import type { ReactNode } from 'react'

// Red 스텁(#70) — 구현 단계에서 aside·폭 조절 구분선을 채운다
export function SidebarFrame({ children }: { className?: string; children: ReactNode }) {
  return <>{children}</>
}
