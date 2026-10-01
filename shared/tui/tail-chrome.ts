// PURO: o que da tela da TUI é moldura e não conteúdo. A saída ao vivo do cartão
// mostra ~10 linhas; metade delas eram réguas "────", o separador "╌╌╌" do menu
// e o prompt vazio "›" — sobravam 2-3 linhas úteis.

// Só caracteres de caixa/régua (e espaço): uma linha que é só moldura.
const RULE_RE = /^[\s─━│┃┄┅┆┇┈┉┊┋╌╍╎╏═║┌┐└┘├┤┬┴┼╭╮╯╰╴╵╶╷▔▁]+$/
// O prompt vazio da caixa de input (claude "❯", codex "›", shell ">").
const EMPTY_PROMPT_RE = /^\s*[›>❯]\s*$/

export function isTailChrome(text: string): boolean {
  return RULE_RE.test(text) || EMPTY_PROMPT_RE.test(text)
}

// Tira a moldura, junta linhas em branco seguidas numa só (`blank`) e apara as
// em branco das pontas. `textOf` dá o texto puro de cada linha (as linhas podem
// ser segmentos com cor).
export function stripTailChrome<T>(
  lines: readonly T[],
  textOf: (line: T) => string,
  blank: T,
): T[] {
  const out: T[] = []
  let gap = false
  for (const line of lines) {
    const text = textOf(line)
    if (text.trim() === '') {
      gap = out.length > 0
      continue
    }
    if (isTailChrome(text)) continue
    if (gap) out.push(blank)
    gap = false
    out.push(line)
  }
  return out
}
