// Janela de leitura do buffer do xterm para os parsers de TUI.
//
// O tail fixo de 40 linhas era um teto silencioso: um menu mais ALTO que isso
// (preview por opção, descrições longas, ou só wrap de linhas longas — o buffer
// conta linhas VISUAIS) chegava ao parser sem a pergunta e sem as primeiras
// opções. Como os parsers são fail-closed e exigem a run começando em "1.", o
// resultado era `null` e o chat caía no banner "responda no terminal".
//
// Medido com o parser real, variando só o tamanho do preview: menu de 14/21/36
// linhas parseia no tail de 40; menu de 51/71 linhas devolve null no tail de 40
// e parseia perfeitamente com o texto inteiro. É determinístico no tamanho do
// que está desenhado — o que, de fora, parece "às vezes funciona, às vezes não".
//
// A escalada só acontece DEPOIS que a primeira janela falha, então todo caso
// que já funcionava segue exatamente pelo mesmo caminho: regressão zero por
// construção. Ampliar é seguro porque os parsers ancoram no FIM do buffer (a
// run contígua que termina na última linha numerada, com só rodapé/branco/
// preview depois) — uma tela antiga mais acima no scrollback não é contígua
// com a atual e por isso não é escolhida.
export const TAIL_WINDOWS = [40, 80, 160, 320] as const

export function parseWithGrowingWindow<T>(
  readTail: (lines: number) => string,
  parse: (text: string) => T | null,
  bufferLines: number,
  windows: readonly number[] = TAIL_WINDOWS,
): T | null {
  for (let i = 0; i < windows.length; i++) {
    const n = windows[i]
    const parsed = parse(readTail(n))
    if (parsed) return parsed
    // Janela já cobre o buffer inteiro: ampliar mais leria o mesmo texto.
    if (n >= bufferLines) return null
  }
  return null
}
