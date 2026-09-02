import { ipcMain } from 'electron'
import { z } from 'zod'
import { getPref, setPref } from '../services/prefs-store'
import {
  AUTO_PULL_ENABLED_KEY,
  AUTO_PULL_INTERVAL_MINUTES_KEY,
  rescheduleAutoPull,
  runAutoPullNow,
} from '../services/repo-pull-scheduler'
import { CUSTOM_ENV_VARS_KEY } from '../services/custom-env'
import { AUTO_DETECT_KEY, rescheduleDetector } from '../services/meetings/meeting-detector'

const getSchema = z.object({ key: z.string().min(1) })
const setSchema = z.object({ key: z.string().min(1), value: z.unknown() })

// Prefs que guardam segredo não passam pelo canal genérico: um `prefs:get`
// devolveria o envelope cifrado (inútil) e um `prefs:set` regravaria em claro,
// desfazendo a cifragem em repouso. O renderer usa `secrets:env:*`.
const SECRET_KEYS = new Set<string>([CUSTOM_ENV_VARS_KEY])

export function assertNotSecretKey(key: string): void {
  if (SECRET_KEYS.has(key)) {
    throw new Error(`pref "${key}" guarda segredo — use o canal secrets:env:*`)
  }
}

export function registerPrefsIpc(): void {
  ipcMain.handle('prefs:get', (_e, payload: unknown) => {
    const { key } = getSchema.parse(payload)
    assertNotSecretKey(key)
    // Contrato IPC inalterado: ausência/JSON inválido → null.
    return getPref<unknown>(key, null)
  })

  ipcMain.handle('prefs:set', (_e, payload: unknown) => {
    const { key, value } = setSchema.parse(payload)
    assertNotSecretKey(key)
    setPref(key, value)
    // Ligar/desligar o toggle de auto-pull ou mudar o intervalo reagenda o cron na
    // hora. Ligar o toggle reflete a intenção na hora: puxa já (best-effort, gated).
    if (key === AUTO_PULL_ENABLED_KEY || key === AUTO_PULL_INTERVAL_MINUTES_KEY) {
      rescheduleAutoPull()
      if (key === AUTO_PULL_ENABLED_KEY && value === true) void runAutoPullNow()
    }
    if (key === AUTO_DETECT_KEY) rescheduleDetector()
  })
}
