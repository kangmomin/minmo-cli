import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

// 버튼으로 여는 메뉴 — 우클릭 메뉴(context-menu)와 달리 키보드로도 열 수 있다
export const DropdownMenu = (props: ComponentProps<typeof DropdownMenuPrimitive.Root>) => <DropdownMenuPrimitive.Root {...props} />
export const DropdownMenuTrigger = (props: ComponentProps<typeof DropdownMenuPrimitive.Trigger>) => (
  <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
)

export function DropdownMenuContent({ className, sideOffset = 4, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn('z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md', className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

export function DropdownMenuItem({
  className,
  variant = 'default',
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item> & { variant?: 'default' | 'destructive' }) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground focus:ring-2 focus:ring-inset focus:ring-ring data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[variant=destructive]:text-destructive [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  )
}
