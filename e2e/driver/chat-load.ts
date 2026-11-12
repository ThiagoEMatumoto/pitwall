import type { Locator } from 'playwright'
import type { PerfLine } from '../../shared/types/perf'

// Prova de que a carga das fases de digitação chegou à tela: transcript gravado
// não é carga se o chat não o desenhou enquanto as teclas entravam.

export interface ChatLoadRead {
  /** Texto do último bloco de markdown do pane; nulo sem chat montado (modo terminal). */
  lastReply: string | null
  /** Nós de elemento do documento inteiro; nulo na leitura que não os conta. */
  domNodes: number | null
  /** Quanto a leitura ocupou a página: ela roda dentro da janela medida da fase. */
  readMs: number
}

// Roda DENTRO da página, sobre o elemento do pane. Só usa o que existe desde antes
// da janela de linhas do chat: `.markdown-body` é a raiz do MarkdownViewer.
// A última resposta fica a poucos nós do fim do pane: o caminho é de trás para a
// frente, porque um querySelectorAll varreria o chat inteiro (187 mil nós com 60 MB
// sem janela de linhas) dentro da janela medida.
// textContent, não innerText: este forçaria layout dentro da janela medida.
function readInPage(pane: Element, countNodes: boolean): ChatLoadRead {
  const started = performance.now()
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_ELEMENT)
  let last: Node | null = pane
  while (walker.lastChild()) last = walker.currentNode
  let lastReply: string | null = null
  for (; last && last !== pane; last = walker.previousNode()) {
    if ((last as Element).classList.contains('markdown-body')) {
      lastReply = last.textContent
      break
    }
  }
  const domNodes = countNodes ? document.getElementsByTagName('*').length : null
  return { lastReply, domNodes, readMs: performance.now() - started }
}

export function readChatLoad(pane: Locator, timeoutMs: number): Promise<ChatLoadRead> {
  return pane.evaluate(readInPage, true, { timeout: timeoutMs })
}

/**
 * A leitura de quando a última tecla entrou: o laço aberto ainda pinta as últimas
 * teclas, então ela não conta os nós do documento.
 */
export function readLastReply(pane: Locator, timeoutMs: number): Promise<ChatLoadRead> {
  return pane.evaluate(readInPage, false, { timeout: timeoutMs })
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
