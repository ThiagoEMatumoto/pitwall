import { ipcMain } from 'electron'
import * as featureStore from '../services/feature-store'
import * as featureFocus from '../services/feature-focus'
import { getDb } from '../services/db'
import {
  broadcast,
  broadcastAffectedObjectivesForFeatureLinks as broadcastAffectedObjectives,
} from '../services/notify'
import { featureMemory, type SessionExitInfo } from '../services/feature-memory'
import type {
  Feature,
  FeatureListStatsOpts,
  FeatureObjectiveLink,
  FeatureWithStats,
  CreateFeatureInput,
  UpdateFeatureInput,
  SetFeatureReposInput,
  SetFeatureObjectiveLinksInput,
  FeatureBackfillResult,
  MergeFeatureDuplicateInput,
  SetFeatureFocusInput,
} from '../../../shared/types/ipc'

export function registerFeaturesIpc(): void {
  ipcMain.handle('features:list', (_e, projectId?: string): Feature[] => {
    return featureStore.list(projectId)
  })

  ipcMain.handle(
    'features:list-with-stats',
    (_e, opts?: FeatureListStatsOpts): FeatureWithStats[] => {
      return featureStore.listWithStats(opts)
    },
  )

  ipcMain.handle('features:get', (_e, id: string): Feature | null => {
    return featureStore.get(id)
  })

  ipcMain.handle('features:create', (_e, input: CreateFeatureInput): Feature => {
    const feature = featureStore.create(input)
    broadcast('feature:updated', feature)
    return feature
  })

  ipcMain.handle('features:update', (_e, input: UpdateFeatureInput): Feature => {
    const feature = featureStore.update(input)
    broadcast('feature:updated', feature)
    return feature
  })

  ipcMain.handle('features:archive', (_e, id: string): void => {
    featureStore.archive(id)
    // Sinaliza o renderer pra recarregar a lista (a feature some dela).
    broadcast('feature:updated', { id, archived: true })
  })

  ipcMain.handle('features:set-repos', (_e, input: SetFeatureReposInput): Feature => {
    const feature = featureStore.setRepos(input.id, input.repos)
    broadcast('feature:updated', feature)
    return feature
  })

  ipcMain.handle(
    'features:set-objective-links',
    (_e, input: SetFeatureObjectiveLinksInput): Feature => {
      const previous = featureStore.setObjectiveLinks(input.featureId, input.links)
      const feature = featureStore.get(input.featureId)
      if (!feature) throw new Error(`feature not found: ${input.featureId}`)
      broadcast('feature:updated', feature)
      // Notifica tanto os objetivos que ganharam quanto os que perderam a feature.
      broadcastAffectedObjectives([...previous, ...input.links])
      return feature
    },
  )

  ipcMain.handle(
    'features:list-objective-links',
    (_e, featureId: string): FeatureObjectiveLink[] => {
      return featureStore.listObjectiveLinks(featureId)
    },
  )

  // Foco da parede + suspeita de duplicata (Fase 4). Vivem AQUI e não em
  // ipc/loop.ts porque pinned/focus_rank/duplicate_of são colunas de `features`:
  // o broadcast correto é 'feature:updated' (que a lista já escuta e que pinga o
  // coordinator de sync, já que a tabela é sincronizada). Em 'loop:updated' o
  // dado mudaria sem o push de sync acontecer.
  const updated = (id: string): Feature => {
    const feature = featureStore.get(id)
    if (!feature) throw new Error(`feature not found: ${id}`)
    broadcast('feature:updated', feature)
    return feature
  }

  ipcMain.handle('features:set-focus', (_e, input: SetFeatureFocusInput): Feature => {
    featureFocus.setFocus(input.featureId, {
      pinned: input.pinned,
      focusRank: input.focusRank,
    })
    return updated(input.featureId)
  })

  ipcMain.handle('features:dismiss-duplicate', (_e, featureId: string): Feature => {
    featureFocus.clearDuplicateSuspect(featureId)
    return updated(featureId)
  })

  // Mesclar ARQUIVA a origem e devolve o destino (que absorveu o trabalho); o
  // broadcast sai pelos dois porque as duas rows mudaram na lista.
  ipcMain.handle('features:merge-duplicate', (_e, input: MergeFeatureDuplicateInput): Feature => {
    featureFocus.mergeDuplicate(input.sourceId, input.targetId)
    broadcast('feature:updated', { id: input.sourceId, archived: true })
    return updated(input.targetId)
  })

  // Backfill retroativo: reprocessa sessões já encerradas e ainda não vinculadas,
  // criando/linkando as features perdidas. A LINKAGEM é síncrona e rápida (sem LLM);
  // a geração de registros ricos (Stage 1) + síntese holística (Stage 2) roda numa
  // fila throttled em background, pra não travar a UI nem disparar rajada de LLM.
  // Em ordem cronológica pra que features criadas cedo capturem sessões posteriores.
  ipcMain.handle('features:backfill', (): FeatureBackfillResult => {
    const rows = getDb()
      .prepare(
        `SELECT id, cc_session_id, repo_id, feature_id FROM sessions
          WHERE status IN ('exited','closed_by_user')
            AND cc_session_id IS NOT NULL
            AND feature_id IS NULL
          ORDER BY started_at ASC`,
      )
      .all() as Array<{
      id: string
      cc_session_id: string
      repo_id: string
      feature_id: string | null
    }>

    let created = 0
    let linked = 0
    let skipped = 0
    const jobs: Array<{ info: SessionExitInfo; featureId: string }> = []
    for (const r of rows) {
      const info: SessionExitInfo = {
        sessionId: r.id,
        ccSessionId: r.cc_session_id,
        repoId: r.repo_id,
        featureId: r.feature_id,
      }
      const res = featureMemory.registerOnly(info)
      if (!res) {
        skipped++
        continue
      }
      if (res.kind === 'auto-created') created++
      else linked++
      jobs.push({ info, featureId: res.featureId })
    }
    // Background: gera os registros (throttled) e, ao terminar cada feature, a
    // síntese holística. Não bloqueia o retorno do backfill.
    featureMemory.enqueueRecords(jobs)
    broadcast('feature:updated', { backfill: true })
    return { created, linked, skipped }
  })
}
