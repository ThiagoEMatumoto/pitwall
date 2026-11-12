import type { GpuAutoDisabled } from '../../../shared/types/ipc'

// Os motivos que gpu-state.ts grava: os três de crash de driver e o 'legacy' da
// migração. Um motivo fora da lista aparece como veio.
const REASONS: Record<string, string> = {
  crashed: 'o driver de vídeo falhou',
  oom: 'faltou memória de vídeo',
  'launch-failed': 'o processo de vídeo não subiu',
  legacy: 'motivo desconhecido, herdado de uma versão anterior',
}

export function describeGpuAutoOff(record: GpuAutoDisabled): string {
  const since = new Date(record.at).toLocaleDateString('pt-BR')
  return `desde ${since} (${REASONS[record.reason] ?? record.reason})`
}
