import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

export function TooltipProvider({ delayDuration = 300, ...props }: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />
}

export const Tooltip = (props: ComponentProps<typeof TooltipPrimitive.Root>) => <TooltipPrimitive.Root {...props} />
export const TooltipTrigger = (props: ComponentProps<typeof TooltipPrimitive.Trigger>) => (
  <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
)

export function TooltipContent({ className, sideOffset = 4, ...props }: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn('z-50 w-fit max-w-xs rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground', className)}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
}
