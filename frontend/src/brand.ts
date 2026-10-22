// The Verea logo (designed by the team; source Verea.svg, Adobe metadata removed) and the
// brand colours taken from it. One place for every place that draws it: page, login, PDF, HTML.

export const BRAND = {
  navy: '#193352',          // logo letters
  teal: '#3da3bc',          // logo waves
  navyDeep: '#0f2236',      // dark frames: profile panel, exported images, table headers
  navyLine: '#1f3550',      // grid / borders on navyDeep
  navyAxis: '#3b5675',
  tealDark: '#23768b',      // teal text on white (AA contrast)
  tealLight: '#6cc4d8',     // teal on dark backgrounds
  rowAlt: '#eef3f7',
}

const VIEW_W = 1076.85
const VIEW_H = 429.4
/** The "V" with the waves: favicon and small marks. */
const MARK_BOX = '-70 -5 440 440'

const LETTERS = [
  'M124.63,426.3l-9.09-18.48-16.24-35.28-33.57-72.81-10.59-22.97-31.85-69.05c-6.87-14.9-12.61-29.49-20.52-43.88-1.47-2.53-2.07-5.14-2.77-8.08l52.98.2,97.41,212.53,95.17-212.62,51.98.09-121.56,270.18-51.35.17Z',
  'M445.69,366.07l27.74,28.95c-17.72,19.3-40.87,30.21-66.59,33.12-24.66,2.79-48.84.78-71.65-9.54-18.72-8.47-35.01-22.2-45.14-40.41-15.71-28.23-17.58-62.12-6.49-92.33,19.03-51.85,75.82-72.61,128.41-60.81,53.37,13.51,79.13,61.57,73.44,115.3h-160.31c3.34,21.63,18.91,38.58,40.29,45.01,15.72,4.43,32.03,4.5,47.77.28,12.29-3.65,22.7-9.45,32.55-19.56ZM438.23,306.64c-4.04-28.16-27.13-45.7-53.85-45.86-28.69-1.3-53.73,17.16-58.93,46.06l112.78-.19Z',
  'M574.21,329.26l-.14,96.65-48.33.28v-201.42s46.43-.03,46.43-.03l.34,28.08c7.83-10.82,17.99-18.47,30.37-23.64,13.61-5.23,27.77-7.42,42.83-6.59l-.2,44.89c-28.78-2.64-56.49,6.05-66.36,33.82-3.12,8.79-4.93,17.79-4.94,27.96Z',
  'M832.34,365.79l27.96,29.19c-31.03,33.79-81.56,41.05-123.9,28.97-22.1-6.3-40.25-18.71-54.09-37.07-14.61-19.38-19.64-42.88-18.84-67.24,1.45-44.36,30.05-81.97,72.99-93.46,20.62-5.52,41.42-5.74,62.36-1.09,53.54,13.88,78.97,60.6,73.21,115.24l-160.43-.04c3.97,22.55,20.03,40.04,42.47,45.67,17.44,4.41,35.36,3.47,52.24-2.52,9.63-4.13,18.06-8.93,26.04-17.66ZM824.92,306.83c-2.87-23.76-21.54-42.22-45.69-45.51-16.16-2.2-31.91.88-45.25,10.22-11.39,8.57-18.76,20.67-21.63,35.23l112.58.05Z',
  'M1002.3,426.01c-38.07,9.38-87.33-.59-101-38.14-3.97-10.9-3.99-22.64-1.85-33.46,6.55-33.13,42.78-48.43,74.55-48.56l62.49-.26c1.56-18.51-8.67-35.8-27.34-40.67-29.05-7.57-59.25-1.66-83.62,17.05l-19.32-34.73c30.43-22.61,76.06-30.53,114.07-22.08,20.08,4.47,37.82,16.15,46.73,34.62,6.47,13.41,9.16,28.03,9.23,43.16l.61,123.24h-36.23s-.57-23.42-.57-23.42c-10.6,12.08-23.06,19.64-37.76,23.27ZM1036.6,356.19l.48-17.45-53.78.24c-19.95.09-37.44,8.15-37.14,26.72.16,10.23,6.42,19.68,16.96,23.46,30.1,10.8,69.1-1.77,73.49-32.96Z',
]
const V_ONLY = LETTERS.slice(0, 1)
const WAVES = [
  'M38.06,73.98l.23.51c68.01-46.95,153.15-47.11,221.79.32l.56-.99.68-1.45.87-2.14c.66-1.52.74-1.58,2-3.8l6.91-16.26c2.26-4.85,3.41-6.96,4.28-9.38.32-.9-.14.35.71-1.52.08-.17.12-.27.2-.44.03-.06.06-.15.09-.21.04-.09.09-.18.12-.26.05-.12.12-.25.15-.33.01-.03.04-.08.04-.09,0,0-.03-.02-.04-.03-.02-.01-.04-.03-.06-.04-.02-.02-.05-.03-.07-.05-77.37-50.28-177.6-50.56-254.66.15',
  'M51.12,103.11l16.53,36.85c47.71-40.68,115.78-39.61,162.94.6l16.64-37.1c-57.94-43.47-138.32-44.31-196.1-.35Z',
  'M80.65,168.96l17.48,38.99c19.98-29.46,58-35.4,85.91-15.48,6.27,4.48,10.8,9.26,16.38,15.36l17.14-38.23c-38.28-37.47-99.13-37.76-136.92-.63Z',
]
const DOT = '<circle cx="149.26" cy="242.01" r="25.54"/>'

function svg(viewBox: string, letters: string[], ink: string, teal: string, extra = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${extra}>`
    + `<g fill="${ink}">${letters.map((d) => `<path d="${d}"/>`).join('')}</g>`
    + `<g fill="${teal}">${WAVES.map((d) => `<path d="${d}"/>`).join('')}${DOT}</g></svg>`
}

/** The whole logo as SVG text; `ink` colours the letters (navy on light, white on dark). */
export function logoSvg(ink: string = BRAND.navy, teal: string = BRAND.teal, attrs = ''): string {
  return svg(`0 0 ${VIEW_W} ${VIEW_H}`, LETTERS, ink, teal, attrs)
}

/** Only the "V" with its waves (square box). */
export function markSvg(ink: string = BRAND.navy, teal: string = BRAND.teal, attrs = ''): string {
  return svg(MARK_BOX, V_ONLY, ink, teal, attrs)
}

export const LOGO_RATIO = VIEW_H / VIEW_W

/** Rasterize SVG text to a PNG data URL (jsPDF does not take SVG). */
export async function svgToPng(svgText: string, width: number, height: number): Promise<string> {
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    c.getContext('2d')!.drawImage(img, 0, 0, width, height)
    return c.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}
