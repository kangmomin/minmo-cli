import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

export const ContextMenu = (props: ComponentProps<typeof ContextMenuPrimitive.Root>) => <ContextMenuPrimitive.Root {...props} />
export const ContextMenuTrigger = (props: ComponentProps<typeof ContextMenuPrimitive.Trigger>) => (
  <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
)

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn('z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md', className)}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

export function ContextMenuItem({
  className,
  variant = 'default',
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Item> & { variant?: 'default' | 'destructive' }) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[variant=destructive]:text-destructive',
        className,
      )}
      {...props}
    />
  )
}

export function ContextMenuSeparator({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator data-slot="context-menu-separator" className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}
