import { RAW_PROMPT } from './fake-home'

// Comparação do que foi digitado com o que uma camada (textarea, IPC, PTY, tela)
// recebeu. Vale 100% dos caracteres na ordem: um espaço a mais ou duas letras
// trocadas divergem no ponto em que acontecem.

export interface TypedComparison {
  ok: boolean
  // Caracteres iguais, na ordem, antes da primeira divergência.
  matched: number
  expectedLength: number
  actualLength: number
  // Os dois lados em volta do primeiro ponto diferente.
  firstDivergence: { index: number; expected: string; actual: string } | null
}

const CONTEXT_CHARS = 6

export function compareTyped(expected: string, actual: string): TypedComparison {
  const want = Array.from(expected)
  const got = Array.from(actual)
  const different = want.findIndex((char, i) => char !== got[i])
  const ok = different === -1 && got.length === want.length
  const index = different === -1 ? want.length : different
  const around = (chars: string[]): string =>
    chars.slice(Math.max(0, index - CONTEXT_CHARS), index + CONTEXT_CHARS + 1).join('')
  return {
    ok,
    matched: index,
    expectedLength: want.length,
    actualLength: got.length,
    firstDivergence: ok ? null : { index, expected: around(want), actual: around(got) },
  }
}

// O que chegou ao PTY, uma entrada por Enter, sem os marcadores do
// bracketed-paste que o composer põe em volta do texto. A última entrada é a
// linha ainda aberta.
export function submittedLines(written: string): string[] {
  return written.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '').split('\r')
}

// O eco do stub raw na tela, uma entrada por prompt. A última é a linha aberta.
export function promptLines(screen: string): string[] {
  return screen.split(RAW_PROMPT).slice(1)
}
