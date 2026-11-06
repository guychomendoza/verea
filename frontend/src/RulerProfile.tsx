// Elevation profile of what the ruler measured: in the bottom panel on a desktop (the map stays
// clear), floating over the map on phones and in the field mode.
import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { distance, num } from './geo'
import { CloseButton } from './icons'
import { loadPlotly } from './plotly'
import { PLOTLY_CONFIG } from './profilePlot'
import { PATH_TERRAIN_TRACE, pathFigure, pathStats, type PathProfile } from './rulerProfile'

const metres = (v: number) => `${Math.round(v).toLocaleString('es-MX')} m`

export function RulerProfile({ points, docked, onHover, onClose }: {
  points: [number, number][]
  docked?: boolean
  onHover: (at: [number, number] | null) => void
  onClose: () => void
}) {
  const [profile, setProfile] = useState<PathProfile | null>(null)
  const [error, setError] = useState('')
  const el = useRef<HTMLDivElement>(null)
  const hover = useRef(onHover)
  hover.current = onHover

  // Ask again when the path changes, once the clicks stop
  const key = JSON.stringify(points)
  useEffect(() => {
    const path = JSON.parse(key) as [number, number][]
    if (path.length < 2) return
    const ctl = new AbortController()
    const timer = setTimeout(() => {
      api.elevationProfile(path, ctl.signal)
        .then((p) => { setProfile(p); setError('') })
        .catch((e: Error) => { if (e.name !== 'AbortError') setError('No se pudo obtener el perfil de elevación.') })
    }, 250)
    return () => { clearTimeout(timer); ctl.abort() }
  }, [key])

  useEffect(() => {
    const div = el.current
    if (!div || !profile) return
    let cancelled = false
    loadPlotly().then((Plotly) => {
      if (cancelled) return
      const { data, layout } = pathFigure(profile)
      Plotly.react(div, data as Plotly.Data[], layout as Partial<Plotly.Layout>,
        { ...PLOTLY_CONFIG, displayModeBar: false } as Partial<Plotly.Config>)
      const chart = div as unknown as Plotly.PlotlyHTMLElement
      chart.removeAllListeners?.('plotly_hover')
      chart.removeAllListeners?.('plotly_unhover')
      chart.on('plotly_hover', (ev) => {
        const pt = ev.points.find((q) => q.curveNumber === PATH_TERRAIN_TRACE)
        if (pt) hover.current(profile.coordinates[pt.pointIndex])
      })
      chart.on('plotly_unhover', () => hover.current(null))
    })
    return () => { cancelled = true }
  }, [profile])

  useEffect(() => () => hover.current(null), [])

  const s = profile && pathStats(profile)
  return (
    <section className={`ruler-profile ${docked ? 'docked' : ''}`} role="region" aria-label="Perfil de elevación de la regla">
      <header>
        <b>Perfil de elevación</b>
        {s && (
          <dl>
            <div><dt>Distancia</dt><dd>{distance(s.length_m)}</dd></div>
            <div><dt>Mín / Máx</dt><dd>{metres(s.min_m)} / {metres(s.max_m)}</dd></div>
            <div><dt>Subida</dt><dd>+{metres(s.gain_m)}</dd></div>
            <div><dt>Bajada</dt><dd>−{metres(s.loss_m)}</dd></div>
            <div><dt>Pendiente media</dt><dd>{num(s.avg_slope_pct, 1)} %</dd></div>
            <div><dt>Pendiente máx.</dt><dd>{num(s.max_slope_pct, 1)} %</dd></div>
          </dl>
        )}
        <CloseButton onClick={onClose} label="Cerrar perfil de elevación" />
      </header>
      {error ? <p className="ruler-profile-note">{error}</p>
        : !profile && <p className="ruler-profile-note">Calculando perfil…</p>}
      <div ref={el} className="ruler-profile-chart" data-testid="ruler-profile-chart" />
    </section>
  )
}
