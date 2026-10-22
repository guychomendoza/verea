// Plotly is large: loaded the first time a profile is shown, with the Spanish locale.
import { PLOTLY_LOCALE } from './profilePlot'

export type PlotlyModule = typeof import('plotly.js-dist-min').default
let plotlyPromise: Promise<PlotlyModule> | null = null

export function loadPlotly(): Promise<PlotlyModule> {
  plotlyPromise ??= import('plotly.js-dist-min').then((m) => {
    const P = m.default
    ;(P as unknown as { register: (x: unknown) => void }).register(PLOTLY_LOCALE)
    return P
  })
  return plotlyPromise
}

export function plotlyLoaded(): boolean {
  return plotlyPromise !== null
}
