import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  customEnvStatus,
  deleteCustomEnvVar,
  listCustomEnvEntries,
  renameCustomEnvVar,
  revealCustomEnvVar,
  setCustomEnvVar,
} from '../services/custom-env'
import { clearServiceHealthCache, serviceStatuses } from '../services/service-proxy'

// Canal dedicado às env vars customizadas do usuário, separado de `prefs:*`
// justamente para que o texto claro NÃO trafegue por um get genérico. A UI
// recebe só nomes de chave + se há valor; o valor decifrado sai daqui uma chave
// por vez, sob ação explícita do usuário (botão de revelar).

const keySchema = z.object({ key: z.string().min(1) })
const setSchema = z.object({ key: z.string().min(1), value: z.string() })
const renameSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
})

// Mudança em credencial invalida o cache de health dos serviços (um "sem
// credencial" cacheado sobreviveria 5min à chave recém-gravada).
function afterMutation(): void {
  clearServiceHealthCache()
}

export function registerSecretsIpc(): void {
  ipcMain.handle('secrets:env:status', () => customEnvStatus())

  ipcMain.handle('secrets:services:status', () => serviceStatuses())

  ipcMain.handle('secrets:env:list', () => listCustomEnvEntries())

  ipcMain.handle('secrets:env:reveal', (_e, payload: unknown) => {
    const { key } = keySchema.parse(payload)
    return revealCustomEnvVar(key)
  })

  ipcMain.handle('secrets:env:set', (_e, payload: unknown) => {
    const { key, value } = setSchema.parse(payload)
    setCustomEnvVar(key, value)
    afterMutation()
    return customEnvStatus()
  })

  ipcMain.handle('secrets:env:delete', (_e, payload: unknown) => {
    const { key } = keySchema.parse(payload)
    deleteCustomEnvVar(key)
    afterMutation()
    return customEnvStatus()
  })

  ipcMain.handle('secrets:env:rename', (_e, payload: unknown) => {
    const { from, to } = renameSchema.parse(payload)
    renameCustomEnvVar(from, to)
    afterMutation()
    return customEnvStatus()
  })
}
