import type { FeatureSessionSummary } from '../../../shared/types/ipc'

// Timestamp que ordena a lista de sessões da feature: a última coisa que
// aconteceu nela (encerrada quando encerrou, senão quando começou).
export function sessionMoment(s: FeatureSessionSummary): number {
  return s.endedAt ?? s.startedAt
}
