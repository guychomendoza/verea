// The state of each node in one word, for the list filters and the bulk model change.
import type { CellStatus, LinkResult, NodeDevice } from './types'

export type NodeState = 'cell-ok' | 'cell-edge' | 'cell-possible' | 'cell-none' | 'cell-unknown'
  | 'lora-ok' | 'lora-fail' | 'lora-none'

export function nodeState(n: NodeDevice, cellular: boolean, links: Record<string, LinkResult>,
  cells: Record<string, CellStatus>): NodeState {
  if (cellular) {
    const c = cells[n.name]
    if (!c) return 'cell-unknown'
    return c.state === 'ok' ? 'cell-ok' : c.state === 'none' ? 'cell-none' : c.state === 'possible' ? 'cell-possible' : 'cell-edge'
  }
  const l = links[n.name]?.link
  return !l ? 'lora-none' : l.viable ? 'lora-ok' : 'lora-fail'
}

/** Groups offered as filters / bulk selections (several states each). */
export const STATE_GROUPS: { key: string; label: string; states: NodeState[] }[] = [
  { key: 'cell-none', label: 'Sin 4G', states: ['cell-none'] },
  { key: 'cell-possible', label: '4G posible', states: ['cell-possible'] },
  { key: 'cell-edge', label: '4G incierto', states: ['cell-edge'] },
  { key: 'cell-ok', label: '4G garantizado', states: ['cell-ok'] },
  { key: 'lora-fail', label: 'LoRa no viable', states: ['lora-fail'] },
  { key: 'lora-none', label: 'LoRa sin resultado', states: ['lora-none'] },
  { key: 'lora-ok', label: 'LoRa viable', states: ['lora-ok'] },
]
