import { useEffect, useState } from 'react'
import type { ComponentProps } from 'react'

import { ago } from '../agents/overview'

// Why: 현재 시각은 이 컴포넌트만 가진다 — 목록·요약 카드 전체가 1초마다 다시 그려지지 않게.
export function Elapsed({ since, ...props }: { since: number } & Omit<ComponentProps<'span'>, 'children'>) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return <span {...props}>{ago(now - since)}</span>
}
