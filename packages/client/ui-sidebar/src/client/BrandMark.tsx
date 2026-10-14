/**
 * Personal AW monogram for the sidebar brand mark.
 *
 * Geometry is the AW optical small-size master: a 640:416 viewBox whose
 * thickened terminals survive a 24px box. The mark paints with the surrounding
 * ink, so one geometry serves the light and dark themes without an asset swap.
 */

/** Native viewBox of the AW optical mark, in user units. */
const AW_MARK_VIEWBOX = { width: 640, height: 416 }

/** AW optical small-size path data, in drawing order. */
const AW_MARK_PATHS = [
  'M 95 164 L 156 0 H 168 L 277 274 Q 291 306 331 258 L 273 416 H 261 L 158 167 Q 145 111 122 137 Z',
  'M 262 0 H 381 L 492 275 Q 505 305 546 258 L 486 416 H 473 L 326 68 Q 307 17 262 15 Z',
  'M 551 0 H 640 L 607 84 H 592 Q 620 18 551 16 Z',
  'M 32 332 H 47 Q 19 403 92 400 V 416 H 0 Z',
]

/** Props for {@link BrandMark}. */
interface BrandMarkProps {
  /** Width in px; the height keeps the master's 640:416 ratio. */
  readonly size?: number
  /** Extra class for layout placement. */
  readonly className?: string
}

/**
 * Render the AW brand mark.
 * @param props - width and optional class.
 * @returns the mark svg (aria-hidden; pair it with the wordmark for accessibility).
 */
export function BrandMark({ size = 24, className }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={(size * AW_MARK_VIEWBOX.height) / AW_MARK_VIEWBOX.width}
      className={className}
      viewBox={`0 0 ${AW_MARK_VIEWBOX.width} ${AW_MARK_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      {AW_MARK_PATHS.map(path => <path key={path} d={path} fill="currentColor" />)}
    </svg>
  )
}
