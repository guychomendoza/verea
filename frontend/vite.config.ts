/// <reference types="vitest" />
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const COVERAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/coverage')

// Development only: serve the coverage PMTiles from data/coverage with HTTP Range
// support (the map reads them piece by piece). In production they live on R2.
function coverageFiles(): Plugin {
  return {
    name: 'verea-coverage-files',
    configureServer(server) {
      server.middlewares.use('/coverage', (req, res, next) => {
        const name = path.basename(decodeURIComponent((req.url ?? '').split('?')[0]))
        const file = path.join(COVERAGE_DIR, name)
        if (!name.endsWith('.pmtiles') || !fs.existsSync(file)) return next()
        // The interactive HTML report is opened from disk and reads the layer from here
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Headers', 'Range')
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, ETag')
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        const size = fs.statSync(file).size
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Content-Type', 'application/octet-stream')
        if (!m) {
          res.setHeader('Content-Length', size)
          fs.createReadStream(file).pipe(res)
          return
        }
        const start = Number(m[1])
        const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
        res.statusCode = 206
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
        res.setHeader('Content-Length', end - start + 1)
        fs.createReadStream(file, { start, end }).pipe(res)
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), coverageFiles()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  test: {
    environment: 'jsdom',
  },
})
