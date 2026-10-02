// Dica de atalho de rodapé de overlay (paleta, seletor, modal do terminal): as
// teclas e o que elas fazem. Um formato só; antes cada overlay escrevia o seu.
export interface ShortcutHint {
  keys: string[]
  label: string
}

/** O texto corrido da dica (title, aria e testes): "Alt+, / Alt+. trocar · Esc fecha". */
export function hintText(hints: ShortcutHint[]): string {
  return hints.map((h) => `${h.keys.join(' / ')} ${h.label}`).join(' · ')
}

// Rodapé padrão dos overlays de lista (paleta, seletor).
export const OVERLAY_HINTS: ShortcutHint[] = [
  { keys: ['↑', '↓'], label: 'navegar' },
  { keys: ['↵'], label: 'abrir' },
  { keys: ['Esc'], label: 'fechar' },
]
