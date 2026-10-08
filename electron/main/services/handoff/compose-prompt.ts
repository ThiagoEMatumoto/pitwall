// Context-engineering do handoff cross-repo: monta o prompt PT-BR estruturado que
// a sessão-filha recebe. Função PURA (sem I/O) — toda a info chega via args, para
// ser trivialmente testável. Segue o template de prompt-templates.md do usuário
// (Contexto / Tarefa / Restrições / Reporte), com o briefing de peer por cima:
// quem a filha é, com quem fala e como escala um bloqueio.

import { describeEdge, type KindEdge } from '../architecture/kind-phrase'
import type { AgentProviderId, HandoffMode } from '../../../../shared/types/ipc'
import { HANDOFF_CHILD_ALLOW, PROTECTED_BRANCHES } from '../spawn-flags'

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
  // Texto livre que a mãe passou em session_handoff({ context }). Sem esta seção
  // ele era gravado em context_json e nunca chegava à filha.
  context?: string | null
  handoffId: string
  // Apelido endereçável da filha (`<nome>-<escopo>`). É o `-n <name>` do spawn e
  // o `to` do SendMessage — a filha precisa saber o próprio, senão não consegue
  // se referir a si mesma nem entender por que foi chamada assim.
  alias: string
  // Modo de permissão com que a filha sobe — molda as restrições do prompt.
  mode?: HandoffMode
  // Codex sobe sem -n e sem inbox cross-session: não há SendMessage.
  provider?: AgentProviderId
}

const PEER_CHANNELS = [
  '- Seu interlocutor é o remetente da primeira mensagem que você receber. Para responder, copie o `from` da <cross-session-message> para o `to` do SendMessage.',
  '- Você NÃO fala com o humano. Nenhuma pergunta sua vai para ele direto.',
  '- Você NÃO fala com outras sessões filhas. Coordenação cruzada é do orquestrador.',
  '- SendMessage é o canal em tempo real; `handoff_progress`/`handoff_report` é o LOG durável. Mudança de estado relevante vai nos DOIS.',
]

const TERMINAL_CHANNELS = [
  '- O orquestrador fala com você colando mensagens neste terminal. Você responde a ele pelas tools `handoff_progress`, `handoff_ask` e `handoff_report` — é o único canal de volta.',
  '- Você NÃO fala com o humano. Nenhuma pergunta sua vai para ele direto.',
  '- Você NÃO fala com outras sessões filhas. Coordenação cruzada é do orquestrador.',
]

// Derivado do allow real da filha para o briefing não divergir da política: o
// texto antigo proibia push/PR que o settings libera, e a filha travava no conflito.
const PUSHABLE_BRANCH_PREFIXES = HANDOFF_CHILD_ALLOW.flatMap((rule) => {
  const m = /^Bash\(git push origin ([\w-]+)\/\*\)$/.exec(rule)
  return m ? [`${m[1]}/*`] : []
})

const PUBLISH_ALLOWED = `- [ ] Publicar é livre: \`git push -u origin <branch>\` com a branch EXPLÍCITA (${PUSHABLE_BRANCH_PREFIXES.join(', ')}) e \`gh pr create\`. \`git push\` sem nomear a branch pede confirmação.`

const PUBLISH_FORBIDDEN = `- [ ] Proibido: push em branch protegida (${PROTECTED_BRANCHES.join(', ')}), force push, merge de PR (é da mãe/humano), deploy, migration destrutiva, alterar config global.`

// plan é read-only (deny de commit/push no settings) e o Codex só sobe autônomo
// em read-only (assertAutonomousSpawnGuarded): nada para publicar.
const READ_ONLY_FORBIDDEN =
  '- [ ] Proibido: commit, git push, criar PR, deploy, migration destrutiva, alterar config global.'

export function composeHandoffPrompt(args: ComposeHandoffArgs): string {
  const motherLabel = args.motherRepoLabel ?? 'origem'
  const provider = args.provider ?? 'claude'
  const peerChannel = provider === 'claude'

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
    ...(peerChannel ? PEER_CHANNELS : TERMINAL_CHANNELS),
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
    ...(args.mode === 'plan' || provider !== 'claude'
      ? [READ_ONLY_FORBIDDEN]
      : [PUBLISH_ALLOWED, PUBLISH_FORBIDDEN]),
    '- [ ] Circuit breaker: 3 tentativas com abordagens DIFERENTES → BLOQUEIO, não a 4ª.',
  ]
  if (args.mode === 'plan') {
    restricoes.push(
      '- [ ] Você está em PLAN MODE (read-only): investigue e proponha, NÃO edite arquivos.',
    )
  } else if (args.mode === 'auto-edits') {
    restricoes.push(
      '- [ ] Modo auto-edits: edições são aplicadas automaticamente; `rm` pede confirmação; `rm -r`, `git reset --hard`, `git clean` e force push estão bloqueados.',
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
    `- Fora do escopo, ambiguidade material ou trade-off arquitetural: chame \`handoff_ask\` com handoffId="${args.handoffId}" e os campos estruturados${peerChannel ? ' (e avise o orquestrador por SendMessage)' : ''}:`,
    '  - `kind`: decision | confirmation | human_action | question',
    '  - `question`: o BLOQUEIO em 1 linha',
    '  - `options`: [{ key: "A", label: "…" }, { key: "B", label: "…" }] (obrigatório em decision, 2 a 6)',
    '  - `recommendation`: a key que você recomenda, e o porquê em 1 linha no detail da option',
    '  - `costOfError`: o que acontece se errar e se é reversível',
    '  - `risk`: "destructive_data" (migration destrutiva/dados) ou "deploy_infra_spend" (deploy/infra/gasto) quando for o caso; isso torna o pedido human_only e só o humano resolve',
    '- Uma pergunta por chamada. Duas dúvidas = duas chamadas; cada uma é respondida separadamente.',
    '- NUNCA pergunte só no terminal: pergunta fora do handoff_ask não existe para a mãe nem para o humano.',
    '- A resposta chega como <pitwall-answer request-id="…">. Só retome o que ela libera; com outras pendentes, continue esperando.',
    '- Depois de perguntar, PARE e espere. Não escolha sozinho e não invente requisito.',
  ]

  return [
    identidade.join('\n'),
    contextLines.join('\n'),
    ...(args.context?.trim() ? [['## Contexto da mãe', args.context.trim()].join('\n')] : []),
    ['## Tarefa', args.task].join('\n'),
    restricoes.join('\n'),
    reporte.join('\n'),
    decisao.join('\n'),
  ].join('\n\n')
}
