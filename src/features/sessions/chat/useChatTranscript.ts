import { useEffect, useState } from 'react'
import { chatApi } from '@/lib/ipc'
import { acquireChatWatch, releaseChatWatch } from './chat-watch-refs'
import type { ChatMessage } from '../../../../shared/types/ipc'

// Assina o transcript de uma sessão enquanto montado: read inicial + watch do
// JSONL. O broadcast manda a LISTA completa reparseada, então só substituímos o
// estado. Libera o watch no unmount (toggle pro terminal desmonta o ChatView);
// o refcount em chat-watch-refs só faz unwatch quando o último consumidor sai.
export function useChatTranscript(sessionId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  // O read inicial sinaliza inexistência via path null; o broadcast via flag. Isso
  // distingue "aguardando transcript" (arquivo não nasceu) de "vazio real".
  const [transcriptExists, setTranscriptExists] = useState(false)
  // Último arquivo de plano escrito pela sessão (~/.claude/plans/*.md) — usado
  // pra mostrar o CONTEÚDO do plano no card de aprovação pendente.
  const [lastPlanFilePath, setLastPlanFilePath] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Race fix: se um update do watch chegar antes (ou durante) o read inicial, ele
    // é a verdade mais nova — não deixamos o resultado do getTranscript (mais velho)
    // sobrescrevê-lo. Também garante que a 1ª atualização (ex: pergunta recém-escrita)
    // não se perca na janela entre disparar o read e assinar o watch.
    let gotUpdate = false
    setLoading(true)

    // Assina ANTES do read pra não perder updates emitidos nessa janela.
    acquireChatWatch(sessionId)
    const off = chatApi.onTranscriptUpdate((u) => {
      if (u.sessionId !== sessionId) return
      gotUpdate = true
      setMessages(u.messages)
      setTranscriptExists(u.transcriptExists)
      setLastPlanFilePath(u.lastPlanFilePath)
      setLoading(false)
    })

    void chatApi
      .getTranscript(sessionId)
      .then((t) => {
        if (cancelled || gotUpdate) return
        setMessages(t.messages)
        setTranscriptExists(t.path !== null)
        setLastPlanFilePath(t.lastPlanFilePath)
        setLoading(false)
      })
      .catch(() => {
        // Sessão sem transcript no disco ainda (recém-spawnada) ou leitura falhou:
        // segue como vazio; o watch traz as mensagens quando o arquivo aparecer.
        if (cancelled) return
        setLoading(false)
      })

    return () => {
      cancelled = true
      off()
      releaseChatWatch(sessionId)
    }
  }, [sessionId])

  return { messages, loading, transcriptExists, lastPlanFilePath }
}

// Conteúdo de um arquivo de plano (~/.claude/plans) via IPC read-only. null
// enquanto carrega, sem path, ou quando a leitura falha — a UI cai no fallback.
export function usePlanFile(path: string | null): string | null {
  const [content, setContent] = useState<string | null>(null)
  useEffect(() => {
    if (!path) {
      setContent(null)
      return
    }
    let cancelled = false
    void chatApi
      .readPlanFile(path)
      .then((c) => {
        if (!cancelled) setContent(c)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [path])
  return content
}
