// Context-engineering do handoff cross-repo: monta o prompt PT-BR estruturado que
// a sessão-filha recebe. Função PURA (sem I/O) — toda a info chega via args, para
// ser trivialmente testável. Segue o template de prompt-templates.md do usuário
// (Contexto / Tarefa / Restrições / Reporte), com o briefing de peer por cima:
// quem a filha é, com quem fala e como escala um bloqueio.

import { describeEdge, type KindEdge } from '../architecture/kind-phrase'
import type { HandoffMode } from '../../../../shared/types/ipc'

// HandoffEdge é a aresta orientada ao repo-mãe (ver KindEdge no módulo compartilhado).
//   'from-mother': a aresta sai do repo-mãe (mãe → este repo).
//   'to-mother':   a aresta entra no repo-mãe (este repo → mãe).
export type HandoffEdge = KindEdge

export interface ComposeHandoffArgs {
  targetRepoLabel: string
  targetRepoPath: string
  motherRepoLabel?: string
  task: string
  edges: HandoffEdge[]
  featureTitle?: string | null
  handoffId: string
  // Apelido endereçável da filha (`<nome>-<escopo>`). É o `-n <name>` do spawn e
  // o `to` do SendMessage — a filha precisa saber o próprio, senão não consegue
  // se referir a si mesma nem entender por que foi chamada assim.
  alias: string
  // Modo de permissão com que a filha sobe — molda as restrições do prompt.
  mode?: HandoffMode
}

export function composeHandoffPrompt(args: ComposeHandoffArgs): string {
  const motherLabel = args.motherRepoLabel ?? 'origem'

  // O canal de volta NÃO depende de a filha saber quem é a mãe de antemão: ela
  // responde a quem escreveu primeiro (o `from` da <cross-session-message>).
  const identidade = [
    'Você é uma sessão de trabalho persistente sob um orquestrador.',
    '',
    '## Identidade',
    `- Seu apelido: ${args.alias}`,
    `- Seu escopo: ${args.targetRepoLabel} — ${args.task}`,
    `- handoffId: ${args.handoffId}`,
    '',
    '## Canais',
    '- Seu interlocutor é o remetente da primeira mensagem que você receber. Para responder, copie o `from` da <cross-session-message> para o `to` do SendMessage.',
    '- Você NÃO fala com o humano. Nenhuma pergunta sua vai para ele direto.',
    '- Você NÃO fala com outras sessões filhas. Coordenação cruzada é do orquestrador.',
    '- SendMessage é o canal em tempo real; `handoff_progress`/`handoff_report` é o LOG durável. Mudança de estado relevante vai nos DOIS.',
  ]

  const contextLines: string[] = [
    '## Contexto',
    `Trabalho end-to-end vindo do repo ${motherLabel}; relação com este repo:`,
  ]
  for (const edge of args.edges) {
    contextLines.push(`- ${describeEdge(edge, motherLabel, args.targetRepoLabel)}`)
  }
  if (args.featureTitle) {
    contextLines.push(`- Feature relacionada: ${args.featureTitle}`)
  }

  const restricoes = [
    '## Restrições',
    `- [ ] Investigar/implementar SOMENTE neste repo (${args.targetRepoLabel}, ${args.targetRepoPath}). Precisou de outro repo → BLOQUEIO para o orquestrador, não vá lá.`,
    '- [ ] Se algo não está no código real, diga "não encontrado" em vez de inferir.',
    '- [ ] Proibido: git push, criar PR, deploy, migration destrutiva, alterar config global.',
    '- [ ] Circuit breaker: 3 tentativas com abordagens DIFERENTES → BLOQUEIO, não a 4ª.',
  ]
  if (args.mode === 'plan') {
    restricoes.push(
      '- [ ] Você está em PLAN MODE (read-only): investigue e proponha, NÃO edite arquivos.',
    )
  } else if (args.mode === 'auto-edits') {
    restricoes.push(
      '- [ ] Modo auto-edits: edições são aplicadas automaticamente; comandos destrutivos (rm, git push/reset --hard, force push) estão bloqueados.',
    )
  }

  const reporte = [
    '## Reporte',
    `- Ao começar: \`handoff_progress\` com handoffId="${args.handoffId}" e o primeiro passo.`,
    '- A cada mudança de passo MATERIAL (não a cada tool call). Progresso de verdade, não microação.',
    '- Se ficar >10 min sem progresso: `handoff_progress` com o motivo do stall.',
    `- Ao terminar: \`handoff_report\` com handoffId="${args.handoffId}" e um summary com EVIDÊNCIA POSITIVA — comando rodado + output observado. "Parece pronto" e ausência de erro NÃO são evidência.`,
    '- O summary: até 250 palavras (descoberta principal + arquivos tocados + próximo passo). NÃO cole código longo.',
    '- Só reporte quando o trabalho estiver REALMENTE concluído E verificado (testes/typecheck passando). "done" significa done.',
  ]

  const decisao = [
    '## Quando precisar de decisão',
    '- Dentro do seu escopo: decida você e registre no summary.',
    `- Fora do escopo, ambiguidade material ou trade-off arquitetural: chame \`handoff_ask\` com handoffId="${args.handoffId}" e mande um SendMessage ao orquestrador, no formato:`,
    '  "BLOQUEIO: <1 linha> | OPÇÕES: A) … B) … | RECOMENDO: <A|B> porque <1 linha> | CUSTO DE ERRAR: <reversível|irreversível>"',
    '- Depois PARE e espere. Não escolha sozinho e não invente requisito.',
  ]

  return [
    identidade.join('\n'),
    contextLines.join('\n'),
    ['## Tarefa', args.task].join('\n'),
    restricoes.join('\n'),
    reporte.join('\n'),
    decisao.join('\n'),
  ].join('\n\n')
}
