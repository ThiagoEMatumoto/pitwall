// Fim do buffer do xterm como texto plano, uma linha por \n (trim à direita).
// IBuffer.length = scrollback + viewport, getLine 0-based: o tail são as linhas
// [length - n, length). Fonte única do texto que os parsers de TUI leem, no renderer
// (xterm) e no espelho headless do main: um teste que lê por aqui lê o que o app lê.
export interface TailReadable {
  readonly buffer: {
    readonly active: {
      readonly length: number
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined
    }
  }
}

export function readBufferTail(term: TailReadable, n: number): string {
  const buf = term.buffer.active
  let text = ''
  for (let y = Math.max(0, buf.length - n); y < buf.length; y++) {
    text += (buf.getLine(y)?.translateToString(true) ?? '') + '\n'
  }
  return text
}
