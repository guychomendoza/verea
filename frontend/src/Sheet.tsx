// Phones: a bottom sheet over the full-screen map, like map apps. Three heights: peek (the
// project's name), half and full; drag the grip up / down, or tap it.
import { useEffect, useRef } from 'react'

export type SheetSize = 'peek' | 'half' | 'full'
const ORDER: SheetSize[] = ['peek', 'half', 'full']

export default function Sheet({ size, onSize, label, contentKey, children }: {
  size: SheetSize; onSize: (s: SheetSize) => void; label: string
  contentKey: string                   // what it shows: switching (project ↔ a device) starts at the top
  children: React.ReactNode
}) {
  const start = useRef<number | null>(null)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => { body.current?.scrollTo({ top: 0 }) }, [contentKey])
  const i = ORDER.indexOf(size)
  const tap = () => onSize(size === 'peek' ? 'half' : size === 'half' ? 'full' : 'half')
  return (
    <section className={`sheet sheet-${size}`} aria-label={label}>
      <div className="sheet-grip" role="button" tabIndex={0} aria-expanded={size !== 'peek'}
        aria-label={size === 'full' ? 'Reducir el panel' : 'Ampliar el panel'}
        onPointerDown={(e) => { start.current = e.clientY; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerUp={(e) => {
          if (start.current === null) return
          const dy = e.clientY - start.current
          start.current = null
          if (Math.abs(dy) < 10) tap()
          else onSize(ORDER[Math.max(0, Math.min(2, i + (dy < 0 ? 1 : -1) * (Math.abs(dy) > 220 ? 2 : 1)))])
        }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tap() } }}>
        <span className="sheet-bar" />
      </div>
      <div className="sheet-body" ref={body}>{children}</div>
    </section>
  )
}
