import type { Liveness } from '../../../shared/feature-loop'
import type { FeatureStatus } from '../../../shared/types/ipc'

// Cor (var CSS) + label pt-BR por status. Cores reaproveitam o design system:
// warning (laranja-âmbar), success (verde), text-dim (cinza neutro).
export const STATUS_META: Record<FeatureStatus, { label: string; color: string }> = {
  pending: { label: 'pendente', color: 'var(--color-text-dim)' },
  'in-progress': { label: 'em andamento', color: 'var(--color-warning)' },
  blocked: { label: 'bloqueada', color: 'var(--color-danger)' },
  done: { label: 'concluída', color: 'var(--color-success)' },
  paused: { label: 'pausada', color: 'var(--color-text-dim)' },
}

export const STATUS_ORDER: FeatureStatus[] = [
  'in-progress',
  'pending',
  'blocked',
  'paused',
  'done',
]

// Vitalidade DERIVADA (shared/feature-loop.ts) — mesmo vocabulário visual do
// STATUS_META acima: cor do design system + label pt-BR, nada de hex novo.
// 'done' usa accent (e não success como o status) pra não se confundir com
// 'alive': concluído é fim de loop, vivo é loop girando.
export const LIVENESS_META: Record<Liveness, { label: string; color: string }> = {
  alive: { label: 'vivo', color: 'var(--color-success)' },
  quiet: { label: 'silêncio', color: 'var(--color-warning)' },
  broken: { label: 'quebrado', color: 'var(--color-danger)' },
  paused: { label: 'pausado', color: 'var(--color-text-dim)' },
  done: { label: 'concluído', color: 'var(--color-accent)' },
}
