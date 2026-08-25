// Lógica pura da inserção de texto ditado no draft do composer — sem DOM,
// testável em vitest. O Composer resolve foco/posição do cursor e chama esta
// função pra montar o novo valor + posição final do cursor.

// Insere `text` no intervalo [selStart, selEnd) de `value`. Um espaço separa o
// ditado do texto vizinho DOS DOIS LADOS quando não há espaço/quebra de linha:
// à esquerda, ditado após texto digitado (ou ditados consecutivos) não pode
// colar no que veio antes; à direita, cursor no início de palavra ou seleção
// que engoliu o espaço não pode colar o ditado na palavra seguinte. O cursor
// final fica logo após o ditado, ANTES do separador à direita.
export function insertDictation(
  value: string,
  text: string,
  selStart: number,
  selEnd: number,
): { value: string; cursor: number } {
  const before = value.slice(0, selStart)
  const after = value.slice(selEnd)
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
  return {
    value: before + lead + text + trail + after,
    cursor: before.length + lead.length + text.length,
  }
}
