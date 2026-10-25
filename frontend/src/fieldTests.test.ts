import { describe, expect, it } from 'vitest'
import { haversine } from './geo'
import { NEAR_M, testBounds, testNear, testsCsv, withFieldTests, type FieldTest } from './fieldTests'
import type { CellStatus, NodeDevice } from './types'

const test = (over: Partial<FieldTest> = {}): FieldTest => ({
  client_id: 'a', project_id: null, taken_at: '2026-10-20T12:00:00Z', lat: 20.5, lon: -103.3, accuracy_m: 5,
  operator: 'Telcel', predicted: 'none', observed: 'stable', delivered: true, rssi_dbm: null, notes: '', ...over,
})

describe('field-test squares', () => {
  it('reach at least NEAR_M each way and sit on the 0.0004° coverage grid', () => {
    const t = test()
    const [w, s, e, n] = testBounds(t)
    expect(haversine([t.lat, w], [t.lat, t.lon])).toBeGreaterThanOrEqual(NEAR_M - 0.5)
    expect(haversine([t.lat, e], [t.lat, t.lon])).toBeGreaterThanOrEqual(NEAR_M - 0.5)
    expect(haversine([s, t.lon], [t.lat, t.lon])).toBeGreaterThanOrEqual(NEAR_M - 0.5)
    expect(haversine([n, t.lon], [t.lat, t.lon])).toBeLessThan(NEAR_M + 50)
    for (const v of [w, s, e, n]) expect(Math.abs(v / 0.0004 - Math.round(v / 0.0004))).toBeLessThan(1e-6)
  })

  it('hold a point 190 m away on the diagonal, not one 260 m away straight north', () => {
    const t = test()
    const d = 190 / Math.SQRT2 / 111320
    expect(testNear(t.lat + d, t.lon + d / Math.cos((t.lat * Math.PI) / 180), [t])).toBe(t)
    expect(testNear(t.lat + 260 / 111320, t.lon, [t])).toBeNull()
  })

  it('the most recent test wins where squares overlap', () => {
    const old = test({ client_id: 'old', observed: 'none' })
    const recent = test({ client_id: 'new', taken_at: '2026-10-24T12:00:00Z', lat: 20.501 })
    expect(testNear(20.5005, -103.3, [recent, old])?.client_id).toBe('new')
    const cells = { S: { name: 'S', state: 'none' } as CellStatus }
    const nodes = [{ name: 'S', lat: 20.5005, lon: -103.3 } as NodeDevice]
    expect(withFieldTests(cells, nodes, new Set(['S']), [old, recent]).S).toMatchObject({ state: 'ok', field: true })
  })
})

describe('testsCsv', () => {
  it('one row per test, «;» separated, with whether the reading arrived', () => {
    const csv = testsCsv([test({ delivered: false, notes: 'junto a la bomba; caña alta' })], () => 'Rancho')
    const [head, row] = csv.replace('﻿', '').split('\r\n')
    expect(head.split(';')).toContain('llego_el_dato')
    expect(row).toContain('No llegó')
    expect(row).toContain('"junto a la bomba; caña alta"')
    expect(row.endsWith('Rancho')).toBe(true)
  })
})
