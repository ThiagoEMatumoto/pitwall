// Texto que o Pitwall cola na PTY de uma sessão dentro de um envelope
// <pitwall-…>: o que vem de outra sessão não pode fechar a tag nem virar tecla.

// Teto de espera das tools que bloqueiam aguardando outra sessão (handoff_wait).
export const MAX_WAIT_SECONDS = 60

// Atributo do envelope: sem aspas, sinais de tag nem quebra — um alias forjado não
// injeta atributo nem fecha a tag.
export function attr(value: string): string {
  return value.replace(/["<>\r\n]/g, '').trim()
}

// Controles fora \n e \t saem: ESC[201~ fecharia o bracketed-paste e o resto
// viraria digitação crua (com \r = Enter).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g

export function sanitizeBody(text: string): string {
  return text.replace(CONTROL_CHARS, '').replace(/<\/pitwall-/gi, '<\\/pitwall-')
}
