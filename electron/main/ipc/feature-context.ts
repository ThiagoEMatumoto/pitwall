import { extractKeySections } from '../services/feature-memory'
import type { Feature } from '../../../shared/types/ipc'

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

// Conteúdo do arquivo injetado via --append-system-prompt-file no spawn de
// sessões com feature. Função pura (Feature → string) extraída de sessions.ts
// pra ser testável sem Electron/PTY. O doc é mantido automaticamente pelo
// Pitwall → instruímos a sessão a NÃO editar o doc manualmente.
export function buildFeatureContextContent(
  feature: Feature,
  linkedObjectiveTitles: string[] = [],
): string {
  const sections = extractKeySections(feature.body ?? '')
  const header = [
    `Esta sessão trabalha na feature «${feature.title}».`,
    'O Pitwall mantém este documento automaticamente — NÃO edite o doc manualmente; apenas trabalhe.',
    '',
    `Status atual: ${feature.status}`,
    feature.objective ? `Objetivo: ${feature.objective}` : '',
    okrLine(linkedObjectiveTitles),
  ]
    .filter(Boolean)
    .join('\n')
  // Reforço do auto-tracking (as instructions do MCP server cobrem o resto):
  // aqui a sessão ganha o featureId REAL, sem precisar resolver via feature_list.
  const tracking = `Tracking: this session's feature id is ${feature.id}. Link auto-created tasks to it (parentType "feature") and update its status via feature_update when you finish or get blocked.`
  const head = `${header}\n\n${tracking}`
  return sections ? `${head}\n\n${sections}\n` : `${head}\n`
}
