import type { Page } from 'playwright'

// Leitura do buffer do xterm (scrollback + tela) de uma sessão, pela instância que
// o TerminalHost guarda num ref: com a GPU ligada o renderer é WebGL e não existe
// .xterm-rows para ler do DOM.

// O recorte do React e do xterm que a leitura do buffer usa.
interface FiberLike {
  memoizedState: unknown
  return: FiberLike | null
}
interface HookLike {
  memoizedState: unknown
  next: HookLike | null
}
interface XtermLike {
  loadAddon: unknown
  buffer: {
    active: {
      length: number
      getLine(y: number): { translateToString(trimRight: boolean): string } | undefined
    }
  }
}

export interface XtermBufferRead {
  // Quantos xterm da sessão há naquele lugar. Diferente de 1, ou `text` nulo, é
  // falha de infraestrutura do cenário, não do que ele confere.
  terms: number
  text: string | null
}

// O xterm DESTA sessão, na modal do mapa ou fora dela (a aba).
// O .xterm é filho do host do TerminalHost: sobe pelos fibers a partir do host
// até o ref que guarda a instância e junta as linhas do buffer, sem separador
// (um texto partido na quebra de linha continua inteiro).
export function readXtermBuffer(
  page: Page,
  sessionId: string,
  where: 'modal' | 'aba',
): Promise<XtermBufferRead> {
  return page.evaluate(
    ({ sid, inModal }) => {
      const terms = [...document.querySelectorAll('.xterm')].filter(
        (el) =>
          (el.closest('[data-peek-lift]') != null) === inModal &&
          el.closest('[data-session-id]')?.getAttribute('data-session-id') === sid,
      )
      if (terms.length !== 1) return { terms: terms.length, text: null }
      const host = terms[0].parentElement as unknown as Record<string, unknown> | null
      const key = host ? Object.keys(host).find((k) => k.startsWith('__reactFiber$')) : undefined
      let term: XtermLike | null = null
      let fiber = (host && key ? host[key] : null) as FiberLike | null
      for (; fiber && !term; fiber = fiber.return) {
        let hook = fiber.memoizedState as HookLike | null
        for (; hook && typeof hook === 'object' && 'next' in hook && !term; hook = hook.next) {
          const current = (hook.memoizedState as { current?: XtermLike } | null)?.current
          if (current && typeof current.loadAddon === 'function' && current.buffer?.active) {
            term = current
          }
        }
      }
      if (!term) return { terms: 1, text: null }
      const buffer = term.buffer.active
      let text = ''
      for (let y = 0; y < buffer.length; y++) {
        text += buffer.getLine(y)?.translateToString(true) ?? ''
      }
      return { terms: 1, text }
    },
    { sid: sessionId, inModal: where === 'modal' },
  )
}
