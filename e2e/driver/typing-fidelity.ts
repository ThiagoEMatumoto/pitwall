import { RAW_LOAD_OUTPUT, RAW_PROMPT } from './fake-home'

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

// O eco do stub raw na tela, uma entrada por prompt, sem a saída de carga que
// caiu no meio dele. A última é a linha aberta.
export function promptLines(screen: string): string[] {
  return screen.replaceAll(RAW_LOAD_OUTPUT, '').split(RAW_PROMPT).slice(1)
}

// Quantas saídas de carga do stub raw estão na tela.
export function loadOutputs(screen: string): number {
  return screen.match(RAW_LOAD_OUTPUT)?.length ?? 0
}

// O que uma rodada "sob carga" viu acontecer enquanto digitava.
export interface LoadSeen {
  transcriptLines: number
  // Composer: a última mensagem do chat mudou antes de a digitação acabar.
  chatChanged: boolean
  // xterm: saídas de carga do stub que a rodada pôs na tela.
  screenOutputs: number
}

// As provas de que a carga existiu de fato. Sem elas a rodada "sob carga" mediu o
// mesmo que a sem carga: o transcript cresceu, e quem estava na tela recebeu algo
// para desenhar (o chat no composer, o terminal no xterm) com as teclas entrando.
export function loadChecks(
  surface: 'composer' | 'xterm',
  seen: LoadSeen,
): Array<{ ok: boolean; label: string }> {
  const transcript = {
    ok: seen.transcriptLines > 0,
    label: `${seen.transcriptLines} linhas de transcript gravadas durante a digitação`,
  }
  const rendered =
    surface === 'composer'
      ? {
          ok: seen.chatChanged,
          label: `o chat ${seen.chatChanged ? 'mostrou' : 'NÃO mostrou'} mensagem nova durante a digitação`,
        }
      : {
          ok: seen.screenOutputs > 0,
          label: `${seen.screenOutputs} saídas do stub na tela, no meio do eco`,
        }
  return [transcript, rendered]
}
