import { sessionsApi } from '@/lib/ipc'

// Contrato do IPC `sessions:list-by-feature`. A chave ainda não está declarada
// em `Api` (shared/types/ipc.ts) — a UI programa contra o contrato, mesmo
// padrão do `videoApi` em lib/ipc.ts. Some daqui quando o tipo entrar no shared.
export interface FeatureSessionInfo {
  id: string
  ccSessionId: string | null
  title: string | null
  repoId: string | null
  startedAt: number
  endedAt: number | null
  lastActivityAt: number | null
  // Derivado no main: há PTY viva pra esta sessão neste app.
  isAlive: boolean
}

type SessionsWithListByFeature = {
  listByFeature?: (featureId: string) => Promise<FeatureSessionInfo[]>
}

// Timestamp que ordena a lista: a última coisa que aconteceu na sessão.
export function sessionMoment(s: FeatureSessionInfo): number {
  return s.lastActivityAt ?? s.endedAt ?? s.startedAt
}

// Probe barato: evita gastar um listWithStats inteiro quando o IPC nem existe.
export function listByFeatureAvailable(): boolean {
  return typeof (sessionsApi as unknown as SessionsWithListByFeature).listByFeature === 'function'
}

// `null` = o IPC ainda não existe neste build. Distinto de `[]` (feature sem
// sessão) de propósito: a UI não pode dizer "nenhuma sessão" quando na verdade
// não conseguiu perguntar.
export async function listSessionsByFeature(
  featureId: string,
): Promise<FeatureSessionInfo[] | null> {
  const fn = (sessionsApi as unknown as SessionsWithListByFeature).listByFeature
  if (typeof fn !== 'function') return null
  return fn(featureId)
}
