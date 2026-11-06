import { describe, expect, it } from 'vitest'
import { pathFigure, pathSlopes, pathStats, type PathProfile } from './rulerProfile'

const profile = (elevations: number[], step = 100): PathProfile => ({
  distances_m: elevations.map((_, i) => i * step), elevations_m: elevations,
  coordinates: elevations.map((_, i) => [20 + i * 0.001, -103]), vertices_m: [0, (elevations.length - 1) * step],
  elevation_source: 'test',
})

describe('pathStats', () => {
  it('adds up what the path climbs and descends', () => {
    const s = pathStats(profile([100, 120, 110, 150, 140]))
    expect(s).toMatchObject({ length_m: 400, min_m: 100, max_m: 150, gain_m: 60, loss_m: 20 })
    expect(s.avg_slope_pct).toBeCloseTo(20)
  })

  it('finds the steepest stretch', () => {
    expect(pathStats(profile([100, 100, 130, 130])).max_slope_pct).toBeCloseTo(30)
  })

  it('is zero on flat ground', () => {
    const s = pathStats(profile([500, 500, 500]))
    expect([s.gain_m, s.loss_m, s.avg_slope_pct, s.max_slope_pct]).toEqual([0, 0, 0, 0])
  })
})

describe('pathSlopes', () => {
  it('measures across a DEM cell, so close samples do not exaggerate its steps', () => {
    const d = [0, 30, 60, 90, 120], e = [100, 100, 100, 109, 109]
    expect(Math.max(...pathSlopes(d, e).map(Math.abs))).toBeLessThan(11)
  })
})

describe('pathFigure', () => {
  it('marks each clicked point on the terrain', () => {
    const p = { ...profile([100, 110, 120, 130]), vertices_m: [0, 200, 300] }
    const { data } = pathFigure(p)
    const marks = data[2] as { x: number[]; y: number[] }
    expect(marks.y).toEqual([100, 120, 130])
    expect(marks.x).toEqual([0, 0.2, 0.3])
  })
})
