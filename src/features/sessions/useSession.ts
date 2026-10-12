import { useCallback, useEffect, useRef, useState } from 'react'
import { sessionsApi } from '@/lib/ipc'
import type { PtyDataEvent, PtyExitEvent } from '../../../shared/types/ipc'

interface State {
  exited: boolean
  exitCode: number | null
  error: string | null
}

const INITIAL: State = {
  exited: false,
  exitCode: null,
  error: null,
}

type DataHandler = (data: string) => void

// A sessão já foi spawnada no clique (App.handleSpawn). Aqui só anexamos ao
// stream de uma sessão existente: registramos data/exit e expomos write/resize/kill.
export function useSession(sessionId: string) {
  const [state, setState] = useState<State>(INITIAL)
  const dataHandlerRef = useRef<DataHandler | null>(null)

  const setDataHandler = useCallback((handler: DataHandler | null) => {
    dataHandlerRef.current = handler
  }, [])

  // Devolve a promessa do IPC: quem precisa de confirmação (envio do Composer)
  // espera; o resto ignora como antes.
  const write = useCallback(
    (data: string): Promise<void> => sessionsApi.write(sessionId, data),
    [sessionId],
  )

  const kill = useCallback(() => {
    void sessionsApi.kill(sessionId)
  }, [sessionId])

  const resize = useCallback(
    (cols: number, rows: number) => {
      void sessionsApi.resize(sessionId, cols, rows)
    },
    [sessionId],
  )

  useEffect(() => {
    setState(INITIAL)
    const offData = sessionsApi.onData((e: PtyDataEvent) => {
      if (e.sessionId !== sessionId) return
      dataHandlerRef.current?.(e.data)
    })
    const offExit = sessionsApi.onExit((e: PtyExitEvent) => {
      if (e.sessionId !== sessionId) return
      setState((s) => ({ ...s, exited: true, exitCode: e.exitCode }))
    })
    return () => {
      offData()
      offExit()
    }
  }, [sessionId])

  return { ...state, write, kill, resize, setDataHandler }
}
