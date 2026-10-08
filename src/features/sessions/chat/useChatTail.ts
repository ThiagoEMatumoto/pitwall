import { useEffect, useRef, useState } from 'react'
import { chatApi } from '@/lib/ipc'
import { acquireTailWatch, noteTailWatchCcSessionId, releaseTailWatch } from './chat-watch-refs'
import type { ChatMessage } from '../../../../shared/types/ipc'

// Cauda do chat para o tile da Room. `active` liga a assinatura do main (o tile
// fora da viewport passa false e libera o watcher). A escuta do broadcast fica
// sempre ligada e o estado não é zerado ao pausar: o tile pausado continua
// mostrando as últimas mensagens que recebeu.
export function useChatTail(sessionId: string, active: boolean, ccSessionId: string | null = null) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [transcriptExists, setTranscriptExists] = useState(false)
  const ccSessionIdRef = useRef(ccSessionId)
  ccSessionIdRef.current = ccSessionId

  useEffect(() => {
    setMessages([])
    setTranscriptExists(false)
    return chatApi.onTranscriptTail((t) => {
      if (t.sessionId !== sessionId) return
      setMessages(t.messages)
      setTranscriptExists(t.transcriptExists)
    })
  }, [sessionId])

  useEffect(() => {
    if (!active) return
    acquireTailWatch(sessionId, ccSessionIdRef.current)
    return () => releaseTailWatch(sessionId)
  }, [sessionId, active])

  useEffect(() => {
    if (active) noteTailWatchCcSessionId(sessionId, ccSessionId)
  }, [sessionId, active, ccSessionId])

  return { messages, transcriptExists }
}
