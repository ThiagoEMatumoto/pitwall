import { readFileSync } from 'node:fs'
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { VoiceConfigStatus } from '../../../shared/types/ipc'
import { getVoiceConfig, vozEnvPath } from '../services/voice-config'
import { condense } from '../services/voice-condense'
import { transcribe } from '../services/voice-stt'
import { speak } from '../services/voice-tts'

// bytes chega do renderer como Uint8Array intacto (structured clone do invoke).
const transcribeSchema = z.object({
  bytes: z.instanceof(Uint8Array),
  mime: z.string().min(1),
})

const condenseSchema = z.object({ text: z.string().min(1) })

const ttsSchema = z.object({ text: z.string().min(1) })

// Gate de teste (e2e sem microfone): com CM_VOICE_FIXTURE setada, o áudio
// gravado é trocado pelo conteúdo do arquivo fixture — config, credencial,
// POST e parsing continuam os de produção. O app nunca seta essa env; só o
// harness e2e define, então em produção o ramo é morto.
function fixtureAudio(path: string): { bytes: Uint8Array; mime: string } {
  return {
    bytes: new Uint8Array(readFileSync(path)),
    mime: path.endsWith('.wav') ? 'audio/wav' : 'audio/webm',
  }
}

export function registerVoiceIpc(): void {
  ipcMain.handle('voice:transcribe', (_e, payload: unknown) => {
    const { bytes, mime } = transcribeSchema.parse(payload)
    const fixture = process.env.CM_VOICE_FIXTURE
    if (fixture) {
      const swapped = fixtureAudio(fixture)
      return transcribe(swapped.bytes, swapped.mime)
    }
    return transcribe(bytes, mime)
  })

  ipcMain.handle('voice:condense', (_e, payload: unknown) => {
    const { text } = condenseSchema.parse(payload)
    return condense(text)
  })

  ipcMain.handle('voice:tts', (_e, payload: unknown) => {
    const { text } = ttsSchema.parse(payload)
    return speak(text)
  })

  // Status pra tela de configurações — nunca inclui credencial, só o que é
  // seguro mostrar (URL, modelos, voz).
  ipcMain.handle('voice:config-status', (): VoiceConfigStatus => {
    const path = vozEnvPath()
    const result = getVoiceConfig()
    if (!result.ok) return { ok: false, path, error: result.error }
    const { sttUrl, sttModel, sttLanguage, ttsVoice, ttsModel, ttsSpeed } = result.cfg
    return { ok: true, path, sttUrl, sttModel, sttLanguage, ttsVoice, ttsModel, ttsSpeed }
  })
}
