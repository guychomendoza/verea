// Map preferences remembered per browser, shared by the editor and the field mode.
import { useCallback, useState } from 'react'

const DEVICES_KEY = 'verea.showDevices'

function read(): boolean {
  try { return localStorage.getItem(DEVICES_KEY) !== 'off' } catch { return true }
}

/** Devices on the map: off leaves only the coverage, the field tests and the plots. */
export function useShowDevices(): [boolean, (on: boolean) => void] {
  const [show, setShow] = useState(read)
  const set = useCallback((on: boolean) => {
    setShow(on)
    try {
      if (on) localStorage.removeItem(DEVICES_KEY)
      else localStorage.setItem(DEVICES_KEY, 'off')
    } catch { /* private mode: it just is not remembered */ }
  }, [])
  return [show, set]
}
