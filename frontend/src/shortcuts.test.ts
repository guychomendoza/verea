import { describe, expect, it } from 'vitest'
import { bearing, distance, haversine } from './geo'
import { shortcutFor } from './shortcuts'

const key = (k: string, extra: Partial<KeyboardEvent> = {}, target: unknown = document.body) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, target, ...extra }) as unknown as KeyboardEvent

describe('shortcuts', () => {
  it('maps the keys', () => {
    expect(shortcutFor(key('g'))).toBe('addGateway')
    expect(shortcutFor(key('G'))).toBe('addGateway')
    expect(shortcutFor(key('g', { ctrlKey: true }))).toBe('addGateway')
    expect(shortcutFor(key('n'))).toBe('addNode')
    expect(shortcutFor(key('r'))).toBe('ruler')
    expect(shortcutFor(key('s', { ctrlKey: true }))).toBe('save')
    expect(shortcutFor(key('s', { metaKey: true }))).toBe('save')
    expect(shortcutFor(key('Escape'))).toBe('cancel')
    expect(shortcutFor(key('x'))).toBeNull()
    expect(shortcutFor(key('n', { ctrlKey: true }))).toBeNull()
  })

  it('letters do nothing while typing in a field, Ctrl+S still saves', () => {
    const input = document.createElement('input')
    expect(shortcutFor(key('g', {}, input))).toBeNull()
    expect(shortcutFor(key('n', {}, input))).toBeNull()
    expect(shortcutFor(key('s', { ctrlKey: true }, input))).toBe('save')
    expect(shortcutFor(key('g', {}, document.createElement('select')))).toBeNull()
  })
})

describe('geo', () => {
  it('haversine matches known distances', () => {
    // 0.01° of latitude ≈ 1111.95 m
    expect(haversine([21, -102], [21.01, -102])).toBeCloseTo(1111.95, 0)
    // Aguascalientes centre → Calvillo ≈ 43.6 km
    expect(haversine([21.8818, -102.2916], [21.8465, -102.7186]) / 1000).toBeCloseTo(44.3, 0)
  })
  it('bearing and formats', () => {
    expect(bearing([21, -102], [21.01, -102])).toBeCloseTo(0, 3)
    expect(bearing([21, -102], [21, -101.99])).toBeCloseTo(90, 1)
    expect(distance(850.4)).toBe('850 m')
    expect(distance(1234)).toBe('1.23 km')
  })
})

describe('undo / redo', () => {
  it('Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo, not while typing', () => {
    const ev = (key: string, extra = {}) => ({ key, ctrlKey: true, metaKey: false, altKey: false, target: null, ...extra })
    expect(shortcutFor(ev('z'))).toBe('undo')
    expect(shortcutFor(ev('y'))).toBe('redo')
    expect(shortcutFor(ev('Z', { shiftKey: true }))).toBe('redo')
    expect(shortcutFor(ev('z', { target: document.createElement('input') }))).toBeNull()
  })
})
