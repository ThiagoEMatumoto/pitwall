import { useEffect, useRef, useState } from 'react'
import { voiceApi } from '@/lib/ipc'

export type SummarizeState =
  { status: 'idle' } | { status: 'running' } | { status: 'error'; message: string }

// Erro some sozinho: a mensagem é transiente (lock em voo, turno sem texto) e
// não pode ficar pra sempre ocupando o rodapé.
const ERROR_AUTOCLEAR_MS = 5_000

// Estado do "Resumir agora" mora aqui, no dono do rodapé — não no botão. O
// controle pode migrar pro menu de overflow (desmonta) enquanto o resumo está
// em voo; se o estado morasse nele, o "Resumindo…" sumiria e o resultado — erro
// inclusive — seria descartado em silêncio pelo mountedRef.
export function useSummarizeNow(ccSessionId: string | null) {
  const [state, setState] = useState<SummarizeState>({ status: 'idle' })
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (state.status !== 'error') return
    const timer = setTimeout(() => setState({ status: 'idle' }), ERROR_AUTOCLEAR_MS)
    return () => clearTimeout(timer)
  }, [state])

  function run() {
    if (!ccSessionId) return
    if (state.status === 'running') return
    setState({ status: 'running' })
    void voiceApi.summarizeNow(ccSessionId).then((res) => {
      if (!mountedRef.current) return
      setState(res.ok ? { status: 'idle' } : { status: 'error', message: res.error })
    })
  }

  return { state, run }
}
