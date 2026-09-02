import { useCallback, useEffect, useState } from 'react'
import { meetingsApi } from '@/lib/ipc'
import { useMeetingsStore } from '@/store/meetingsStore'
import type { MeetingEvent } from '../../../shared/types/ipc'

export interface ModelProgress {
  progress: number
  done: boolean
  error: string | null
}

// Renomear speaker e baixar o modelo de voz falam com o main direto: o store
// já aplica o evento 'meeting' que o rename emite; 'model_progress' ele não
// trata, então o progresso fica aqui, assinando o mesmo canal.
export function useSpeakerActions() {
  const [modelProgress, setModelProgress] = useState<ModelProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    return meetingsApi.onEvent((event: MeetingEvent) => {
      if (event.type !== 'model_progress') return
      setModelProgress({
        progress: event.progress,
        done: event.done,
        error: event.error,
      })
      if (event.done) void useMeetingsStore.getState().checkSetup()
    })
  }, [])

  const renameSpeaker = useCallback(async (meetingId: string, speakerId: string, name: string) => {
    setError(null)
    try {
      await meetingsApi.renameSpeaker({ meetingId, speakerId, name })
      // O evento 'meeting' atualiza os speakers, mas os labels dos segmentos
      // só chegam com o detail recarregado.
      await useMeetingsStore.getState().loadDetail(meetingId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const downloadModels = useCallback(async () => {
    setError(null)
    setBusy(true)
    setModelProgress({ progress: 0, done: false, error: null })
    try {
      await meetingsApi.downloadModels()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setModelProgress({ progress: 0, done: true, error: message })
    } finally {
      setBusy(false)
    }
  }, [])

  return { renameSpeaker, downloadModels, modelProgress, error, busy }
}
