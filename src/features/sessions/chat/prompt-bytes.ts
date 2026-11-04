// Controles além de \t, \n e \r saem antes: um ESC colado fecharia o paste
// (\x1b[201~) e o resto do texto chegaria à TUI como tecla.
const UNSAFE_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g

// Monta os bytes de um prompt do composer pro PTY. Normaliza quebras de linha pra
// \r (o TUI do claude trata \r como Enter) e, quando o bracketed-paste do terminal
// está ativo, envolve em \x1b[200~…\x1b[201~ pra que o conteúdo entre os marcadores
// seja colado literalmente — os \r internos NÃO submetem. O \r final que submete é
// do caller (sendPrompt), não daqui. Espelha o formato canônico de
// electron/main/services/handoff/inject.ts.
export function buildPromptBytes(text: string, bracketed: boolean): string {
  const normalized = text.replace(UNSAFE_CONTROLS, '').replace(/\r?\n/g, '\r')
  return bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized
}
