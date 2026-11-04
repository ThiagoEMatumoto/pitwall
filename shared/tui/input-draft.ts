import { inputBoxHasUserText, inputBoxRows, type InputCell } from './attention-reason'

// Caixa de input do claude lida com os atributos de célula: o placeholder é dim, o texto do
// usuário não. Mesmo leitor no espelho headless do main (inputDirty) e no xterm do renderer
// (aviso de rascunho no chat). Depois de Tab/Enter na busca do Ctrl+R (fullscreen) e de
// "Restore conversation" no /rewind, a CLI deixa o prompt na caixa: o chat precisa ver.
export interface CellReadable {
  readonly rows: number
  readonly buffer: {
    readonly active: {
      readonly length: number
      getLine(y: number):
        | {
            readonly length: number
            translateToString(trimRight?: boolean): string
            getCell(x: number): { getChars(): string; isDim(): number } | undefined
          }
        | undefined
    }
  }
}

export interface InputBoxState {
  // Caixa de input ociosa na tela (❯ entre as réguas).
  prompt: boolean
  // Texto do usuário na caixa (sem placeholder); null = vazia.
  draft: string | null
}

// Só o fim da tela: é onde a caixa mora.
export function readInputBox(term: CellReadable): InputBoxState {
  const buf = term.buffer.active
  const first = Math.max(0, buf.length - term.rows - 1)
  const lines: string[] = []
  for (let y = first; y < buf.length; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  const box = inputBoxRows(lines)
  if (!box) return { prompt: false, draft: null }
  const rows: InputCell[][] = []
  for (let r = box.start; r < box.end; r++) {
    const line = buf.getLine(first + r)
    if (!line) continue
    const cells: InputCell[] = []
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x)
      if (cell) cells.push({ chars: cell.getChars(), dim: cell.isDim() !== 0 })
    }
    rows.push(cells)
  }
  if (!inputBoxHasUserText(rows)) return { prompt: true, draft: null }
  const text = rows
    .map((cells, r) => {
      const from = r === 0 ? cells.findIndex((c) => c.chars === '❯') + 1 : 0
      return cells
        .slice(Math.max(0, from))
        .map((c) => (c.dim ? ' ' : c.chars || ' '))
        .join('')
        .trimEnd()
    })
    .join('\n')
    .replace(/ /g, ' ')
    .trim()
  return { prompt: true, draft: text === '' ? null : text }
}
