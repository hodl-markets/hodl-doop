import * as React from 'react'

import { cn } from '@/lib/utils'
import lockupBlack from '@/assets/brand/hodl-markets-lockup-black.png'
import lockupWhite from '@/assets/brand/hodl-markets-lockup-white.png'

/** The HODL Markets lockup (symbol + "HODL Markets"), used in headers and the
 *  auth card: 26px tall at `sm` (the brand book's sidebar size), 32px at `md`
 *  (its sign-in size). Black on the light theme, white on the dark one. The
 *  white file is the Design System's HODLmarkets-logo-white.png; the black one
 *  is the same artwork in the black of HODLmarkets-logo-black.jpg, kept
 *  transparent so it sits on any ground. */
function Wordmark({
  size = 'md',
  className,
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & { size?: 'sm' | 'md' }) {
  const height = size === 'sm' ? 'h-[26px]' : 'h-8'
  return (
    <span data-slot="wordmark" className={cn('flex items-center', className)} {...props}>
      <img src={lockupBlack} alt="HODL Markets" draggable={false} className={cn(height, 'w-auto dark:hidden')} />
      <img src={lockupWhite} alt="HODL Markets" draggable={false} className={cn(height, 'hidden w-auto dark:block')} />
    </span>
  )
}

export { Wordmark }
