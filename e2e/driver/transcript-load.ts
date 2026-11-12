import { appendFileSync } from 'node:fs'

// Acima do debounce de 150 ms do watcher do transcript (chat-transcript-service):
// com appends mais juntos que isso ele só lê quando a rajada para, e o chat não
// desenha nada enquanto se digita.
export const APPEND_EVERY_MS = 300

// Quantos turnos a carga precisa ter para ainda estar gravando ao fim de `ms`.
export function turnsToLast(ms: number): number {
  return Math.ceil(ms / APPEND_EVERY_MS)
}

export interface TranscriptLoad {
  appendedLines(): number
  // Começa a gravar e devolve o que para. A rodada seguinte continua do ponto em
  // que a anterior parou.
  start(): () => void
}

// A carga de chat dos cenários de digitação: o transcript cresce um turno inteiro
// por vez, e cada leitura do watcher traz uma resposta nova do assistant para o
// chat desenhar.
export function transcriptLoad(file: string, stream: string[], turnLines: number): TranscriptLoad {
  let appended = 0
  return {
    appendedLines: () => appended,
    start() {
      const timer = setInterval(() => {
        const turn = stream.slice(appended, appended + turnLines)
        if (turn.length === 0) return
        appendFileSync(file, turn.join('\n') + '\n')
        appended += turn.length
      }, APPEND_EVERY_MS)
      return () => clearInterval(timer)
    },
  }
}
