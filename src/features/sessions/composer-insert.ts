// Lógica pura da inserção de texto ditado no draft do composer — sem DOM,
// testável em vitest. O Composer resolve foco/posição do cursor e chama esta
// função pra montar o novo valor + posição final do cursor.

// Insere `text` no intervalo [selStart, selEnd) de `value`. Quando o que vem
// antes do ponto de inserção não termina em espaço/quebra de linha, um espaço
// separa o ditado do texto existente (ditados consecutivos ou ditado após
// texto digitado não podem colar um no outro).
export function insertDictation(
  value: string,
  text: string,
  selStart: number,
  selEnd: number,
): { value: string; cursor: number } {
  const before = value.slice(0, selStart)
  const after = value.slice(selEnd)
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const inserted = lead + text
  return {
    value: before + inserted + after,
    cursor: before.length + inserted.length,
  }
}
