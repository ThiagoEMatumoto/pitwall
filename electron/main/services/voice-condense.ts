// Condensação do ditado longo: transcrição crua -> claude -p (haiku) -> prompt
// limpo pro composer. Mesma mecânica do baton/distill.ts (runClaude + fence),
// mesmas travas do vozapp/correcao.py: falha é fail-open (o ditado NUNCA se
// perde — volta o original) e volta que inchou demais é reescrita/invenção,
// não condensação — descarta-se.
import { runClaude, TEXT_ONLY_CLAUDE_ARGS } from './claude-cli'
import { stripCodeFence } from './feature-digest'

const CONDENSE_TIMEOUT_MS = 60_000
// Haiku: a condensação roda com o usuário esperando pra revisar o prompt;
// latência importa mais que sofisticação.
const CONDENSE_MODEL = 'haiku'

// Condensar encolhe ou mantém. Uma volta maior que o original significa que o
// modelo explicou/inventou em vez de condensar — melhor o ditado cru.
const MAX_GROWTH_RATIO = 1.2

export const CONDENSE_INSTRUCTION = `Você limpa transcrições de ditado por voz de um engenheiro brasileiro, transformando cada uma num prompt claro para uma ferramenta de programação.

O texto veio de um transcritor automático: ele erra termos técnicos em inglês (escreve o que SOA em português) e o ditado carrega divagação falada — hesitações, repetições, falsos começos, correções no meio da frase.

Sua tarefa, em ordem de importância:
- preserve TODAS as instruções, detalhes técnicos e a intenção de quem falou — nada do que foi pedido pode sumir;
- NÃO invente conteúdo, requisitos nem detalhes que não foram ditos;
- corrija termos técnicos claramente errados (exemplos reais: "força de urgem" era "force merge"; "abrir com request" era "abrir pull request"; "cheques de qualidade" era "checks");
- condense a divagação: corte hesitações, repetições e falsos começos;
- na dúvida entre cortar e manter, mantenha;
- responda SÓ com o texto final, sem comentários nem cerca de código.

Texto ditado:
`

export interface CondenseResult {
  text: string
  condensed: boolean
}

export async function condense(text: string): Promise<CondenseResult> {
  const original = text.trim()
  if (!original) return { text: original, condensed: false }

  // O ditado entra no prompt: guard-rail de tools obrigatório — o condensador
  // NUNCA pode executar ação a partir do que foi falado.
  const result = await runClaude(
    [
      '-p',
      CONDENSE_INSTRUCTION + original,
      '--output-format',
      'text',
      '--model',
      CONDENSE_MODEL,
      ...TEXT_ONLY_CLAUDE_ARGS,
    ],
    { timeoutMs: CONDENSE_TIMEOUT_MS },
  )
  // runClaude nunca rejeita: erro de exec, exit != 0 e timeout chegam como
  // code != 0. Qualquer falha devolve o ditado original intacto.
  if (result.code !== 0) return { text: original, condensed: false }

  const out = stripCodeFence(result.stdout).trim()
  if (!out) return { text: original, condensed: false }
  if (out.length > original.length * MAX_GROWTH_RATIO) return { text: original, condensed: false }

  return { text: out, condensed: out !== original }
}
