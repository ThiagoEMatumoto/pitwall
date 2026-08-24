// Fila FIFO das falas do modo voz, pura pra ser testável sem Audio/browser —
// mesmo padrão de model-queue.ts. O hook (useVoiceSpeaker) cuida do Audio e do
// object URL; toda decisão de ordem/dedupe vive aqui.

export interface SpeakerQueue {
  /** Fala em reprodução (ou sintetizando). null = em repouso. */
  current: string | null
  /** Falas aguardando, em ordem de chegada. */
  queue: string[]
}

export const idleQueue: SpeakerQueue = { current: null, queue: [] }

// Enfileira uma fala; se nada toca, ela começa agora (`start`). Dedupe de
// repique: o broadcast de resumo pode chegar duplicado (mais de um pane da
// mesma sessão) — a mesma fala já tocando ou em QUALQUER posição da fila não
// re-entra (só o fim deixava passar o repique atrasado que chega depois de
// outra fala entrar no meio).
export function enqueueSpeech(
  q: SpeakerQueue,
  text: string,
): { state: SpeakerQueue; start: string | null } {
  if (q.current === text || q.queue.includes(text)) return { state: q, start: null }
  if (q.current === null) return { state: { current: text, queue: [] }, start: text }
  return { state: { current: q.current, queue: [...q.queue, text] }, start: null }
}

// A fala atual terminou: promove a próxima (FIFO) ou volta ao repouso.
export function finishSpeech(q: SpeakerQueue): { state: SpeakerQueue; start: string | null } {
  const [next, ...rest] = q.queue
  if (next === undefined) return { state: idleQueue, start: null }
  return { state: { current: next, queue: rest }, start: next }
}

// Parar limpa tudo — fala atual e fila. Não há retomar: resumo perdido não
// volta (o texto continua visível no chip).
export function stopSpeech(): SpeakerQueue {
  return idleQueue
}
