import type { Feature } from '../../../shared/types/ipc'
import type { Liveness } from '../../../shared/feature-loop'

// Quantas entradas do ledger entram no bloco. Três é o "índice", não o
// conteúdo: dá pro modelo saber que existe histórico e o que mudou por último
// sem transformar o system prompt num dump do doc.
const LEDGER_PREVIEW = 3

// Título de ledger é rótulo de índice, não texto corrido. O corte mantém o
// bloco com teto real: sem ele, uma entrada verborrágica inflaria o system
// prompt de toda sessão da feature.
const LEDGER_TITLE_MAX = 80

/** Recorte do loop que o bloco de contexto precisa — o chamador resolve via loopSnapshot. */
export interface FeatureLoopContext {
  liveness: Liveness
  pulse: { body: string } | null
  /** Já em ordem decrescente de recência (o que listLedger devolve). */
  ledger: readonly { title: string; createdAt: number }[]
}

// Linha do OKR que a feature serve (Onda 2 — causa raiz da sub-linkagem era
// ninguém expor/lembrar isso). `linkedObjectiveTitles` já vem resolvido pelo
// chamador (feature-store.linkedObjectiveTitles) — função continua pura.
function okrLine(linkedObjectiveTitles: string[]): string {
  if (linkedObjectiveTitles.length === 0) {
    return 'Esta feature ainda não está sob nenhum OKR — chame `feature_set_objective_links` pra linkar a um objetivo/key result relevante.'
  }
  const titles = linkedObjectiveTitles.map((t) => `«${t}»`).join(', ')
  return linkedObjectiveTitles.length === 1
    ? `Esta feature serve o OKR ${titles}.`
    : `Esta feature serve os OKRs: ${titles}.`
}

function isoDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// Índice do ledger: data + título, SEM corpo. O corpo mora no arquivo do loop
// e a sessão lê de lá quando precisar.
function ledgerLines(entries: readonly { title: string; createdAt: number }[]): string {
  if (entries.length === 0) return ''
  const head = entries
    .slice(0, LEDGER_PREVIEW)
    .map((e) => `- ${isoDay(e.createdAt)} · ${truncate(e.title, LEDGER_TITLE_MAX)}`)
    .join('\n')
  return `Últimas mudanças registradas:\n${head}`
}

// Caminho do arquivo exportado do loop. Ancorado no worktree do 1º repo
// vinculado; sem repo vinculado sobra o caminho relativo — a sessão resolve a
// partir do cwd dela, que é o único palpite honesto que dá pra dar aqui.
function loopFilePath(feature: Feature): string {
  const root = feature.repos.find((r) => r.worktreePath)?.worktreePath
  const rel = `.pitwall/loop-${feature.slug}.md`
  return root ? `${root}/${rel}` : rel
}

// Conteúdo do arquivo injetado via --append-system-prompt-file no spawn de
// sessões com feature. Função pura (Feature + loop → string) extraída de
// sessions.ts pra ser testável sem Electron/PTY.
//
// O bloco APONTA, não despeja: pulso + índice do ledger + endereço do arquivo
// do loop. Despejar seções inteiras do doc (o que `extractKeySections` fazia
// aqui) gasta context window com material que a sessão pode ler do disco se e
// quando precisar — e cresce sem teto conforme o doc cresce.
export function buildFeatureContextContent(
  feature: Feature,
  linkedObjectiveTitles: string[] = [],
  loop?: FeatureLoopContext | null,
): string {
  const header = [
    `Esta sessão trabalha na feature «${feature.title}».`,
    'O Pitwall mantém este documento automaticamente — NÃO edite o doc manualmente; apenas trabalhe.',
    `Status atual: ${feature.status}${loop ? ` · vitalidade: ${loop.liveness}` : ''}`,
    feature.objective ? `Objetivo: ${feature.objective}` : '',
    // Pulso vigente vai INTEIRO: cabe em 200 caracteres e é o que orienta a
    // sessão sobre onde a frente está agora.
    loop?.pulse ? `Pulso vigente: ${loop.pulse.body}` : '',
    okrLine(linkedObjectiveTitles),
    loop ? ledgerLines(loop.ledger) : '',
    `Loop desta frente no disco: ${loopFilePath(feature)} — leia antes de mudar qualquer coisa aqui; não edite o loop de features irmãs.`,
  ]
    .filter(Boolean)
    .join('\n')
  // Reforço do auto-tracking (as instructions do MCP server cobrem o resto):
  // aqui a sessão ganha o featureId REAL, sem precisar resolver via feature_list.
  const tracking = `Tracking: this session's feature id is ${feature.id}. Link auto-created tasks to it (parentType "feature") and update its status via feature_update when you finish or get blocked.`
  return `${header}\n\n${tracking}\n`
}
