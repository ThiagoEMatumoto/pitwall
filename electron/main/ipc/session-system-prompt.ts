import { get as getFeature, linkedObjectiveTitles } from '../services/feature-store'
import { loopSnapshot } from '../services/loop-snapshot'
import { buildFeatureContextContent, type FeatureLoopContext } from './feature-context'
import { buildRepoArchitectureOrNull } from './repo-architecture-context'

// Separador entre os segmentos do arquivo injetado via --append-system-prompt-file.
const SEGMENT_SEPARATOR = '\n\n---\n\n'

// Conteúdo do contexto da feature (header + loop + bloco tracking) vem do
// builder puro em feature-context.ts; aqui só se resolve o I/O. Retorna null se
// a feature não existe.
export function buildFeatureContextOrNull(featureId: string): string | null {
  const feature = getFeature(featureId)
  if (!feature) return null
  // O loop é enfeite do bloco, não pré-requisito: se a projeção falhar, a
  // sessão nasce com o contexto básico em vez de não nascer.
  let loop: FeatureLoopContext | null = null
  try {
    const snapshot = loopSnapshot(featureId)
    loop = { liveness: snapshot.liveness, pulse: snapshot.pulse, ledger: snapshot.ledger }
  } catch (err) {
    console.error('[session-system-prompt] loopSnapshot falhou:', err)
  }
  return buildFeatureContextContent(feature, linkedObjectiveTitles(featureId), loop)
}

/**
 * Monta o system-prompt anexado à sessão a partir de até três fontes:
 * arquitetura do repo, contexto da feature (pulso/vitalidade/ponteiro do loop)
 * e texto livre. Devolve null quando não há nenhum segmento.
 *
 * FONTE ÚNICA: spawn e resume chamam ESTA função. Enquanto o resume montava o
 * próprio comando, a sessão retomada nascia sem o bloco da feature — e retomar
 * é o gesto mais comum, então na prática o contexto quase nunca chegava.
 */
export function buildSessionSystemPrompt(opts: {
  repoId?: string | null
  featureId?: string | null
  systemPromptText?: string | null
}): string | null {
  const segments: string[] = []
  if (opts.repoId) {
    const archContent = buildRepoArchitectureOrNull(opts.repoId)
    if (archContent) segments.push(archContent)
  }
  if (opts.featureId) {
    const featureContent = buildFeatureContextOrNull(opts.featureId)
    if (featureContent) segments.push(featureContent)
  }
  if (opts.systemPromptText?.trim()) {
    segments.push(opts.systemPromptText)
  }
  return segments.length > 0 ? segments.join(SEGMENT_SEPARATOR) : null
}
