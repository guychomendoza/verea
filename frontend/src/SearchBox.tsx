import { useState } from 'react'
import { api } from './api'
import type { Place } from './types'

/** Place / coordinates search over the map. */
export default function SearchBox({ onPick }: { onPick: (p: Place) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Place[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const search = async () => {
    if (q.trim().length < 2) return
    setBusy(true)
    setError('')
    try {
      const r = (await api.geocode(q.trim())).results
      if (r.length === 1 && r[0].kind === 'coordinates') {
        onPick(r[0])
        setResults(null)
      } else {
        setResults(r)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falló la búsqueda')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="search-box">
      <form role="search" onSubmit={(e) => { e.preventDefault(); search() }} className="flex gap-1">
        <input type="search" value={q} placeholder="Buscar un lugar o 21.88, -102.29"
          aria-label="Buscar ubicación" onChange={(e) => { setQ(e.target.value); setResults(null) }}
          onKeyDown={(e) => e.key === 'Escape' && setResults(null)} />
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Buscando…' : 'Buscar'}</button>
      </form>
      {error && <div className="search-results error">{error}</div>}
      {results && (
        <ul className="search-results" aria-label="Resultados de búsqueda">
          {results.length === 0 && <li className="hint">No se encontraron lugares</li>}
          {results.map((r) => (
            <li key={`${r.lat},${r.lon},${r.name}`}>
              <button onClick={() => { onPick(r); setResults(null) }}>{r.name}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
