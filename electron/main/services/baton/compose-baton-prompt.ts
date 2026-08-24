// Prompt da destilação do bastão: transforma o digest de uma sessão que está com o
// contexto cheio no briefing que a sucessora vai receber. Função PURA (sem I/O),
// como composeHandoffPrompt (handoff/compose-prompt.ts) — o transcript já chega
// destilado em Digest.
//
// A diferença pro buildRecordPrompt (feature-digest.ts:204) é o TEMPO VERBAL: lá o
// registro é post-mortem de uma sessão encerrada ("o que foi feito"); aqui a sessão
// está VIVA no meio do trabalho e o briefing existe pra alguém CONTINUAR — o que
// importa é o estado agora, o porquê das decisões (senão a sucessora as refaz) e o
// próximo passo concreto.
import type { Digest } from '../feature-digest'
import { renderDigestForRecord } from '../feature-digest'

export interface ComposeBatonArgs {
  digest: Digest
  // Rótulo do repo/worktree onde o trabalho acontece — a sucessora sobe em algum
  // lugar e precisa saber qual.
  repoLabel?: string | null
  featureTitle?: string | null
  // Contexto que o humano acrescenta no diálogo da passagem (etapa de UI). O que
  // ele digita ali vale MAIS que o inferido do transcript.
  note?: string | null
}

// As seções do briefing são fixas e citadas no prompt: a sucessora (e a UI) leem
// esse formato, então mexer aqui é mudar contrato, não estilo.
export const BATON_SECTIONS = [
  '## Estado atual',
  '## Decisões e porquês',
  '## Tentado e falhou',
  '## Arquivos em jogo',
  '## Próximo passo',
] as const

// renderDigestForRecord escolhe finalSummary OU as notas do assistant. Numa sessão
// AINDA VIVA a "última mensagem" não é resumo nenhum — é só a última fala. As notas
// cronológicas são justamente onde ficam os becos sem saída, então quando as duas
// coisas existem anexamos as notas de volta.
function renderDigestForBaton(d: Digest): string {
  const base = renderDigestForRecord(d)
  if (!d.finalSummary || d.assistantNotes.length === 0) return base
  const notes = d.assistantNotes.map((n) => `- ${n}`).join('\n')
  return `${base}\n\nNotas do assistant (cronológico):\n${notes}`
}

export function composeBatonPrompt(args: ComposeBatonArgs): string {
  const { digest } = args

  const contexto: string[] = [
    '## Contexto',
    'Uma sessão de trabalho do Claude Code está com o contexto quase cheio e vai ser substituída',
    'por uma sessão limpa que continua exatamente de onde ela parou.',
  ]
  if (args.repoLabel) contexto.push(`- Repo/worktree: ${args.repoLabel}`)
  if (args.featureTitle) contexto.push(`- Feature em andamento: ${args.featureTitle}`)
  if (digest.gitBranch) contexto.push(`- Branch: ${digest.gitBranch}`)
  if (args.note) contexto.push(`- Instrução do humano (prevalece sobre o inferido): ${args.note}`)

  const tarefa = [
    '## Tarefa',
    'Você é quem destila essa sessão no BRIEFING de passagem de bastão. Escreva PARA a sessão',
    'sucessora — não é relatório para humano. Ela não viu nada do que aconteceu: tudo que não',
    'estiver no briefing ela vai redescobrir do zero ou refazer errado.',
    '',
    'Produza Markdown com estas seções EXATAS, nesta ordem:',
    '',
    `${BATON_SECTIONS[0]} — onde o trabalho está agora: o que já funciona, o que está pela metade,`,
    '  o que está quebrado. Concreto (nome de função, comportamento observado), não adjetivo.',
    `${BATON_SECTIONS[1]} — cada decisão técnica/de produto tomada COM o motivo. Sem o porquê a`,
    '  sucessora reabre a discussão e desfaz o que já foi decidido.',
    `${BATON_SECTIONS[2]} — abordagens já descartadas e por que falharam (erro, limitação, custo).`,
    '  Isto evita repetir beco sem saída. Se não houve, escreva "nada registrado".',
    `${BATON_SECTIONS[3]} — arquivos/paths tocados ou centrais, cada um com uma frase do papel dele.`,
    `${BATON_SECTIONS[4]} — a PRÓXIMA ação concreta, no imperativo e acionável ("rodar X", "editar Y`,
    '  para fazer Z"). Uma só, a mais imediata; pendências restantes viram bullets abaixo dela.',
  ]

  const restricoes = [
    '## Restrições',
    '- [ ] Factual e específico. Se algo não está no resumo abaixo, NÃO invente — omita ou diga "não registrado".',
    '- [ ] Sem preâmbulo, saudação ou meta-comentário. A resposta começa direto no `## Estado atual`.',
    '- [ ] Sem cercas de código envolvendo o documento inteiro (trecho curto inline é ok).',
    '- [ ] Português. ~250 a 500 palavras — dá pra ler em um minuto e voltar a trabalhar.',
  ]

  return [
    contexto.join('\n'),
    tarefa.join('\n'),
    restricoes.join('\n'),
    ['===== RESUMO BRUTO DA SESSÃO =====', renderDigestForBaton(digest)].join('\n'),
  ].join('\n\n')
}
