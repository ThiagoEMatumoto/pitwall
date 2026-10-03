// Guard central dos atalhos do mapa: tecla vinda de um terminal (o textarea
// auxiliar do xterm ou qualquer nó dele) ou de um campo editável é texto do
// usuário, não comando do mapa. Sem isto, um "f" digitado no painel da mãe
// dava zoom no mapa em vez de chegar à PTY.
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('.xterm')) return true
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true
  return (
    (target as HTMLElement).isContentEditable ||
    !!target.closest(
      '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]',
    )
  )
}

// Camada aberta sobre o mapa (menu de contexto, Dialog, modal) é dona das teclas
// soltas, e o painel da feature também: ele fica DENTRO do container do mapa, mas
// o escudo dele é React (bolha) e não segura um listener de captura da janela.
const MAP_KEY_LAYERS = '[role="menu"], [data-modal-overlay], [aria-modal="true"]'
export function mapKeysOwnedElsewhere(target: Element): boolean {
  if (target.closest('[data-testid="feature-panel"]')) return true
  return !!target.ownerDocument.querySelector(MAP_KEY_LAYERS)
}
