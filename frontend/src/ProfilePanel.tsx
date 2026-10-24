import { useEffect, useRef, useState } from 'react'
import { dataUrlToBlob, downloadBlob, safeName } from './exportImage'
import { loadPlotly, plotlyLoaded } from './plotly'
import { PLOTLY_CONFIG, PIN_TRACE, TERRAIN_TRACE, profileFigure } from './profilePlot'
import type { Profile } from './types'
import { Icon } from './icons'

interface Props {
  profile: Profile | null
  title: string
  status: string                     // shown when there is no profile
  pins: number[]
  onPins: (pins: number[]) => void
  onHover: (index: number | null) => void
}

/** "Perfil de Elevación": interactive chart (zoom, pan, reset, hover and pins linked to the map). */
export default function ProfilePanel({ profile, title, status, pins, onPins, onHover }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const pinsRef = useRef(pins)
  pinsRef.current = pins
  const handlers = useRef({ onPins, onHover })
  handlers.current = { onPins, onHover }

  // Draw / redraw when the profile changes
  useEffect(() => {
    const div = el.current
    if (!div || !profile) return
    let cancelled = false
    loadPlotly().then((Plotly) => {
      if (cancelled) return
      const { data, layout } = profileFigure(profile, title, pinsRef.current)
      Plotly.react(div, data as Plotly.Data[], layout as Partial<Plotly.Layout>, PLOTLY_CONFIG as Partial<Plotly.Config>)
      setReady(true)
      const chart = div as unknown as Plotly.PlotlyHTMLElement
      chart.removeAllListeners?.('plotly_hover')
      chart.removeAllListeners?.('plotly_unhover')
      chart.removeAllListeners?.('plotly_click')
      chart.on('plotly_hover', (ev) => {
        const pt = ev.points.find((q) => q.curveNumber === TERRAIN_TRACE) ?? ev.points[0]
        if (pt) handlers.current.onHover(pt.pointIndex)
      })
      chart.on('plotly_unhover', () => handlers.current.onHover(null))
      chart.on('plotly_click', (ev) => {
        const pt = ev.points.find((q) => q.curveNumber === TERRAIN_TRACE) ?? ev.points[0]
        if (!pt) return
        const i = pt.pointIndex
        const cur = pinsRef.current
        handlers.current.onPins(cur.includes(i) ? cur.filter((k) => k !== i) : [...cur, i])
      })
    })
    return () => { cancelled = true }
  }, [profile, title])

  // Pins only restyle their trace
  useEffect(() => {
    const div = el.current
    if (!div || !profile || !ready) return
    loadPlotly().then((Plotly) => {
      const x = profile.distances_m.map((v) => v / 1000)
      Plotly.restyle(div, {
        x: [pins.map((i) => x[i])], y: [pins.map((i) => profile.elevations_m[i])],
        text: [pins.map((_, k) => String(k + 1))],
      } as Plotly.Data, [PIN_TRACE])
    })
  }, [pins, profile, ready])

  // Follow the panel size
  useEffect(() => {
    const div = el.current
    if (!div) return
    const ro = new ResizeObserver(() => {
      // Plotly refuses to resize a hidden chart (no profile, or panel collapsed)
      if (ready && div.offsetParent !== null && div.clientWidth > 0 && div.clientHeight > 0) {
        loadPlotly().then((Plotly) => Plotly.Plots.resize(div))
      }
    })
    ro.observe(div)
    return () => ro.disconnect()
  }, [ready])

  useEffect(() => () => {
    const div = el.current
    if (div && plotlyLoaded()) loadPlotly().then((P) => P.purge(div))
  }, [])

  const download = async () => {
    if (!el.current) return
    const Plotly = await loadPlotly()
    const w = Math.max(el.current.clientWidth, 900)
    const url = await Plotly.toImage(el.current, { format: 'png', width: w, height: Math.round(w * 0.5), scale: 2 })
    downloadBlob(dataUrlToBlob(url), `${safeName(title)}.png`)
  }

  return (
    <section className="profile-panel" aria-label="Perfil de Elevación">
      <div className="profile-bar">
        <h2>Perfil de Elevación</h2>
        {profile && (
          <div className="flex gap-2 items-center">
            <span className="hint hidden md:inline">Clic en la gráfica: marcar un punto · rueda: zoom</span>
            {pins.length > 0 && <button className="btn btn-dark" onClick={() => onPins([])}>Borrar puntos ({pins.length})</button>}
            <button className="btn btn-dark" onClick={download}><Icon name="download" size={14} /> Descargar imagen</button>
          </div>
        )}
      </div>
      {!profile && <div className="profile-empty">{status}</div>}
      <div ref={el} className="profile-chart" style={{ display: profile ? 'block' : 'none' }}
        data-testid="profile-chart" />
    </section>
  )
}
