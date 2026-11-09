import { RefreshCwIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '../../components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip'
import { cn } from '../../lib/utils'
import { useRefreshTree } from './useTree'

/** AC-04: 트리 재조회 + ● 갱신 */
export function RefreshButton() {
  const refresh = useRefreshTree()
  const [busy, setBusy] = useState(false)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="새로고침"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void refresh().finally(() => setBusy(false))
          }}
        >
          <RefreshCwIcon className={cn(busy && 'animate-spin')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>트리 새로고침</TooltipContent>
    </Tooltip>
  )
}
