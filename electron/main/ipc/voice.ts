import { ipcMain } from 'electron'
import { z } from 'zod'
import type { VoiceConfigStatus } from '../../../shared/types/ipc'
import { getVoiceConfig, vozEnvPath } from '../services/voice-config'
import { transcribe } from '../services/voice-stt'

// bytes chega do renderer como Uint8Array intacto (structured clone do invoke).
const transcribeSchema = z.object({
  bytes: z.instanceof(Uint8Array),
  mime: z.string().min(1),
})

export function registerVoiceIpc(): void {
  ipcMain.handle('voice:transcribe', (_e, payload: unknown) => {
    const { bytes, mime } = transcribeSchema.parse(payload)
    return transcribe(bytes, mime)
  })

  // Status pra tela de configurações — nunca inclui credencial, só o que é
  // seguro mostrar (URL, modelos, voz).
  ipcMain.handle('voice:config-status', (): VoiceConfigStatus => {
    const path = vozEnvPath()
    const result = getVoiceConfig()
    if (!result.ok) return { ok: false, path, error: result.error }
    const { sttUrl, sttModel, sttLanguage, ttsVoice, ttsModel } = result.cfg
    return { ok: true, path, sttUrl, sttModel, sttLanguage, ttsVoice, ttsModel }
  })
}
