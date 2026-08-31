import { ipcMain } from 'electron'
import * as loopStore from '../services/loop-store'
import { loopSnapshot } from '../services/loop-snapshot'
import { broadcast } from '../services/notify'
import type {
  AppendLedgerInput,
  DeclareMetricInput,
  FeatureLedgerEntry,
  FeatureLoopSnapshot,
  FeatureMetricColumn,
  FeatureMetricPoint,
  FeaturePulse,
  ListLedgerOpts,
  RecordMetricPointInput,
  SetPulseInput,
} from '../../../shared/types/ipc'

// IPC do loop da feature. Arquivo próprio (não dentro de ipc/features.ts)
// porque o namespace exposto no preload também é próprio (`loop`), e aqui a
// convenção é um arquivo por namespace — igual a tasks/objectives.
//
// Canal de broadcast é 'loop:updated', não 'feature:updated': notify.broadcast
// usa o prefixo do canal pra decidir se pinga o coordinator de sync, e as
// tabelas do loop ainda não entram no export sincronizado — 'feature:' aqui
// dispararia push de dado que não mudou.

function notifyLoop(featureId: string): void {
  broadcast('loop:updated', { featureId })
}

export function registerLoopIpc(): void {
  ipcMain.handle('loop:snapshot', (_e, featureId: string): FeatureLoopSnapshot => {
    return loopSnapshot(featureId)
  })

  ipcMain.handle('loop:pulse-set', (_e, input: SetPulseInput): FeaturePulse => {
    const pulse = loopStore.setPulse(
      input.featureId,
      input.body,
      input.source ?? 'human',
      input.sessionId,
    )
    notifyLoop(input.featureId)
    return pulse
  })

  ipcMain.handle(
    'loop:pulse-history',
    (_e, featureId: string, limit?: number): FeaturePulse[] => {
      return loopStore.pulseHistory(featureId, limit)
    },
  )

  ipcMain.handle('loop:ledger-append', (_e, input: AppendLedgerInput): FeatureLedgerEntry => {
    const entry = loopStore.appendLedger(input.featureId, input)
    notifyLoop(input.featureId)
    return entry
  })

  ipcMain.handle(
    'loop:ledger-list',
    (_e, featureId: string, opts?: ListLedgerOpts): FeatureLedgerEntry[] => {
      return loopStore.listLedger(featureId, opts)
    },
  )

  ipcMain.handle('loop:metric-declare', (_e, input: DeclareMetricInput): FeatureMetricColumn => {
    const column = loopStore.declareMetric(input.featureId, input)
    notifyLoop(input.featureId)
    return column
  })

  ipcMain.handle('loop:metric-record', (_e, input: RecordMetricPointInput): FeatureMetricPoint => {
    const point = loopStore.recordMetricPoint(
      input.featureId,
      input.columnKey,
      input.at,
      input.value,
      input.note,
    )
    notifyLoop(input.featureId)
    return point
  })
}
