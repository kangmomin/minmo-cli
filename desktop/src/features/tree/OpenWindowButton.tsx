import { AppWindowIcon } from 'lucide-react'

import { Button } from '../../components/ui/button'

/** 트리 행의 "새 창으로 열기" 버튼 — 다른 행 버튼처럼 hover·포커스 때 보인다. 이름에 대상을 넣는다(AX-21) */
export function OpenWindowButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={`${label} 새 창으로 열기`}
      title={`${label} 새 창으로 열기`}
      onClick={onClick}
      className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
    >
      <AppWindowIcon className="size-3.5" />
    </Button>
  )
}
