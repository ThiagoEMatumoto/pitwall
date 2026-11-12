import { useEffect, useRef, useState } from 'react'
import { chatApi } from '@/lib/ipc'
import { applyTranscriptUpdate } from './chat-logic'
import { acquireChatWatch, noteChatWatchCcSessionId, releaseChatWatch } from './chat-watch-refs'
import type { ChatMessage, ChatTranscriptUpdate } from '../../../../shared/types/ipc'

// Assina o transcript de uma sessão enquanto montado: read inicial + watch do
// JSONL. O main manda deltas numerados (rev): cada um emenda na lista a partir de
// `base`, e os objetos abaixo dele seguem os mesmos. Libera o watch no unmount (toggle
// pro terminal desmonta o ChatView); o refcount em chat-watch-refs só faz unwatch
// quando o último consumidor sai.
export function useChatTranscript(sessionId: string, ccSessionId: string | null = null) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  // O read inicial sinaliza inexistência via path null; o update via flag. Isso
  // distingue "aguardando transcript" (arquivo não nasceu) de "vazio real".
  const [transcriptExists, setTranscriptExists] = useState(false)
  // Último arquivo de plano escrito pela sessão (~/.claude/plans/*.md) — usado
  // pra mostrar o CONTEÚDO do plano no card de aprovação pendente.
  const [lastPlanFilePath, setLastPlanFilePath] = useState<string | null>(null)
  // Lido no acquire sem entrar nas deps: o cc id chegando depois não deve
  // reassinar o transcript, só reativar o watch (efeito abaixo).
  const ccSessionIdRef = useRef(ccSessionId)
  ccSessionIdRef.current = ccSessionId

  useEffect(() => {
    let cancelled = false
    // Lista e rev já aplicados. O rev decide quem é mais novo entre o read (invoke) e os
    // updates (send), seja qual for a ordem em que chegam. -1 = nada aplicado ainda.
    let current: ChatMessage[] = []
    let rev = -1
    // Update que não emenda na lista (um delta se perdeu, ou o read inicial ainda não
    // voltou) espera o read em voo e é reaplicado em cima dele.
    let reading = false
    let held: ChatTranscriptUpdate[] = []
    setLoading(true)

    const show = (
      next: ChatMessage[],
      nextRev: number,
      exists: boolean,
      planFilePath: string | null,
    ) => {
      current = next
      rev = nextRev
      setMessages(next)
      setTranscriptExists(exists)
      setLastPlanFilePath(planFilePath)
      setLoading(false)
    }

    const onUpdate = (u: ChatTranscriptUpdate) => {
      const merged = applyTranscriptUpdate(current, rev, u)
      if (merged.kind === 'stale') return
      if (merged.kind === 'applied') {
        show(merged.messages, u.rev, u.transcriptExists, u.lastPlanFilePath)
        return
      }
      held = [...held, u]
      if (!reading) readTranscript()
    }

    const readTranscript = () => {
      reading = true
      void chatApi
        .getTranscript(sessionId)
        .then((t) => {
          if (cancelled) return
          // Mesmo rev = mesma lista: trocar recriaria todos os objetos à toa.
          if (t.rev > rev) show(t.messages, t.rev, t.path !== null, t.lastPlanFilePath)
          const waiting = held
          held = []
          reading = false
          waiting.forEach(onUpdate)
        })
        .catch(() => {
          // Sessão sem transcript no disco ainda (recém-spawnada) ou leitura falhou:
          // segue como está; o próximo update que não emendar pede o transcript de novo.
          if (cancelled) return
          held = []
          reading = false
          setLoading(false)
        })
    }

    // Assina ANTES do read pra não perder updates emitidos nessa janela.
    acquireChatWatch(sessionId, ccSessionIdRef.current)
    const off = chatApi.onTranscriptUpdate((u) => {
      if (u.sessionId === sessionId) onUpdate(u)
    })
    readTranscript()

    return () => {
      cancelled = true
      off()
      releaseChatWatch(sessionId)
    }
  }, [sessionId])

  useEffect(() => {
    noteChatWatchCcSessionId(sessionId, ccSessionId)
  }, [sessionId, ccSessionId])

  return { messages, loading, transcriptExists, lastPlanFilePath }
}

// Ctrl+G edita o arquivo com o diálogo aberto, e nada na tela do menu muda (o
// fingerprint não tem o texto do plano): só relendo de tempos em tempos.
export const PLAN_FILE_POLL_MS = 1000

// Conteúdo de um arquivo de plano (~/.claude/plans) via IPC read-only. null
// enquanto carrega, sem path, ou quando a leitura falha — a UI cai no fallback.
// `version` muda → relê na hora (o replanejamento regrava o arquivo).
export function usePlanFile(path: string | null, version?: string | null): string | null {
  const [content, setContent] = useState<string | null>(null)
  useEffect(() => {
    if (!path) {
      setContent(null)
      return
    }
    let cancelled = false
    const read = () =>
      void chatApi
        .readPlanFile(path)
        .then((c) => {
          if (!cancelled) setContent(c)
        })
        .catch(() => {})
    read()
    const timer = setInterval(read, PLAN_FILE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [path, version])
  return content
}
