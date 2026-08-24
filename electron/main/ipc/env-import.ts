import { ipcMain } from 'electron'
import { z } from 'zod'
import { applyImport, scanEnvSources } from '../services/env-import'
import { resetDossierPipeline } from '../services/dossier-pipeline-singleton'

// Importador de .env (aba Integrações). O scan devolve só fingerprints + paths;
// o apply recebe {key, sourcePath} e o main relê o VALOR do arquivo escolhido —
// nenhum segredo trafega pelo IPC em direção alguma.

const applySchema = z.object({
  selections: z.array(z.object({ key: z.string().min(1), sourcePath: z.string().min(1) })),
})

export function registerEnvImportIpc(): void {
  ipcMain.handle('secrets:import:scan', () => scanEnvSources())

  ipcMain.handle('secrets:import:apply', (_e, payload: unknown) => {
    const { selections } = applySchema.parse(payload)
    const result = applyImport(selections)
    // Credencial mudou → dossier pipeline invalida o provedor cacheado (mesmo
    // racional do afterMutation de ipc/secrets.ts).
    if (result.applied.length > 0) resetDossierPipeline()
    return result
  })
}
