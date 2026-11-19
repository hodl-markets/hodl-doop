import type { CSSProperties } from 'react'

import { cn } from '@/lib/utils'
import symbolBlack from '@/assets/brand/hodl-symbol-black.png'
import symbolWhite from '@/assets/brand/hodl-symbol-white.png'

/* The HODL symbol, from the HODL Design System's Logos group
   (HODL-logoSymbolOnly-black.png / -white.png), cropped to the mark. The
   brand book says never to recolour or redraw it, so it ships as the two
   official files and the theme picks one. */
const SYMBOL_ASPECT = 265 / 256

/** The HODL symbol at the size the caller's box gives it: black on the light
 *  theme, white on the dark one. Decorative; the control around it carries
 *  the label. */
export function Logo({ className = 'size-[30px]' }: { className?: string }) {
  return (
    <span className={cn('inline-block flex-none', className)} aria-hidden>
      <img src={symbolBlack} alt="" draggable={false} className="size-full object-contain dark:hidden" />
      <img src={symbolWhite} alt="" draggable={false} className="hidden size-full object-contain dark:block" />
    </span>
  )
}

/** The HODL symbol as a glyph inline with text (presence chips, the agent
 *  rows, role badges): the symbol's shape filled with the text colour, or
 *  `color`, so it follows the line it sits on. `size` is the height in px. */
export function DoopMark({
  size = 13,
  color,
  className = 'mr-px inline-block align-[-2px]',
}: {
  size?: number
  color?: string
  className?: string
}) {
  const mask = `url(${symbolBlack}) center / contain no-repeat`
  const style: CSSProperties = {
    width: Math.round(size * SYMBOL_ASPECT),
    height: size,
    backgroundColor: color ?? 'currentColor',
    mask,
    WebkitMask: mask,
  }
  return <span className={className} style={style} aria-hidden />
}
