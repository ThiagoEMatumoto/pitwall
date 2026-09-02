// Liga o motor de diarização (W1-B) ao app: paths dos modelos vindos do
// Electron, o diarizer no registry que o gravador consome, e o download do
// modelo de vozes reportado ao renderer como evento 'model_progress'.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { emitMeetingEvent } from './event-bus'
import { downloadEmbeddingModel, setModelManagerDefaults } from './model-manager'
import { diarizerRegistry, modelDownloadRegistry, recorderRegistry } from './recorder-contract'
import { createDiarizer, type MeetingDiarizer } from './speaker-diarizer'

let diarizer: MeetingDiarizer | null = null

function emitProgress(progress: number, done: boolean, error: string | null): void {
  emitMeetingEvent({ type: 'model_progress', model: 'embedding', progress, done, error })
}

export async function downloadModelWithProgress(
  download: (onProgress: (p: number) => void) => Promise<unknown> = downloadEmbeddingModel,
): Promise<void> {
  let last = 0
  try {
    await download((p) => {
      last = p
      emitProgress(p, false, null)
    })
    emitProgress(1, true, null)
  } catch (err) {
    emitProgress(last, true, err instanceof Error ? err.message : String(err))
    throw err
  }
  // O status da diarização (checkPrereqs) muda com o modelo no disco; o
  // renderer só fica sabendo com um 'state' novo.
  recorderRegistry.current?.refreshState()
}

export function installDiarizer(): MeetingDiarizer {
  // Fora do pacote o main roda de out/main (dev e harness e2e); a raiz do
  // repo — onde vive build/models — é dois níveis acima. app.getAppPath()
  // devolve out/main quando o Electron é lançado direto no index.js.
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  setModelManagerDefaults(() => ({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot,
    userDataDir: app.getPath('userData'),
  }))
  // Sem warmup aqui: o worker sobe no primeiro start() (recorder), não no boot.
  diarizer = createDiarizer()
  diarizerRegistry.current = diarizer
  modelDownloadRegistry.current = () => downloadModelWithProgress()
  return diarizer
}

export function uninstallDiarizer(): void {
  diarizer?.dispose()
  diarizer = null
  diarizerRegistry.current = null
  modelDownloadRegistry.current = null
}
