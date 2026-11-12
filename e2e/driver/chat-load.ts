import type { Locator } from 'playwright'
import type { PerfLine } from '../../shared/types/perf'

// Prova de que a carga das fases de digitação chegou à tela: transcript gravado
// não é carga se o chat não o desenhou enquanto as teclas entravam.

export interface ChatLoadRead {
  /** Texto do último bloco de markdown do pane; nulo sem chat montado (modo terminal). */
  lastReply: string | null
  /** Nós de elemento do documento inteiro. */
  domNodes: number
}

// Roda DENTRO da página, sobre o elemento do pane. Só usa o que existe desde antes
// da janela de linhas do chat: `.markdown-body` é a raiz do MarkdownViewer.
// textContent, não innerText: este forçaria layout dentro da janela medida.
function readInPage(pane: Element): ChatLoadRead {
  const bodies = pane.querySelectorAll('.markdown-body')
  return {
    lastReply: bodies.length > 0 ? bodies[bodies.length - 1].textContent : null,
    domNodes: document.getElementsByTagName('*').length,
  }
}

export function readChatLoad(pane: Locator, timeoutMs: number): Promise<ChatLoadRead> {
  return pane.evaluate(readInPage, undefined, { timeout: timeoutMs })
}

/**
 * Quantos turnos da carga o chat já mostrou, pela última resposta na tela: cada
 * turno do gerador (buildLongMotherLines) termina em "pronto N.", e a carga começa
 * no turno `firstLoadTurn`. Pelo número do turno, não pela contagem de mensagens
 * no DOM: com a janela de linhas, mensagem nova entra e a contagem não muda.
 */
export function loadTurnsShown(lastReply: string | null, firstLoadTurn: number): number {
  const turn = /^pronto (\d+)\./.exec(lastReply ?? '')
  return turn ? Math.max(0, Number(turn[1]) - firstLoadTurn + 1) : 0
}

/** Caracteres de pty:data que o main enviou ao renderer nas linhas de uma fase. */
export function ptyCharsSent(lines: PerfLine[]): number {
  return lines.reduce((sum, line) => sum + (line.counters['pty:data.chars'] ?? 0), 0)
}

export interface TypingLoadSeen {
  surface: 'chat' | 'terminal'
  typedChars: number
  /** Turnos da carga que o chat mostrou entre o começo da fase e a última tecla. */
  chatNewMessages: number
  ptyChars: number
}

// No chat, a carga é mensagem nova desenhada antes da última tecla. No terminal o
// chat está desmontado: a carga é a saída dos PTYs, e o eco do que foi digitado
// (um caractere por tecla) não conta.
export function typingLoadArrived(seen: TypingLoadSeen): boolean {
  return seen.surface === 'chat' ? seen.chatNewMessages > 0 : seen.ptyChars > seen.typedChars
}
