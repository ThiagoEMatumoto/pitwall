import { Kbd } from '@/components/ui/ShortcutHints'
import { Button } from '@/components/ui/Button'
import type { RoomObjectiveLink } from '../../../shared/types/feature-room'
import { COMPACT } from './room-ui'

export function objectiveChainText(links: RoomObjectiveLink[]): string {
  return links
    .map((l) =>
      l.krTitle
        ? `Objetivo: ${l.objectiveTitle} › KR: ${l.krTitle}`
        : `Objetivo: ${l.objectiveTitle}`,
    )
    .join(' · ')
}

interface Props {
  backBadge: number // pedidos de OUTRAS features
  onBack: () => void
  title: string
  chain: RoomObjectiveLink[]
  needsYou: number
  canDelegate: boolean
  onSeeMap: () => void
  onFeatures: () => void
  onNewChild: () => void
  onStartMother: () => void
}

// Barra da Room: feature + cadeia objetivo › KR, e os caminhos de saída.
export function RoomHeader({
  backBadge,
  onBack,
  title,
  chain,
  needsYou,
  canDelegate,
  onSeeMap,
  onFeatures,
  onNewChild,
  onStartMother,
}: Props) {
  const chainText = objectiveChainText(chain)
  return (
    <header className="flex items-center gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
      <Button
        variant="ghost"
        className={COMPACT}
        onClick={onBack}
        title="Voltar para Todas as mães (Esc)"
        aria-label={`Todas as mães, ${backBadge} precisa de você em outras features`}
        data-testid="room-back-all"
      >
        ← Todas as mães
        {backBadge > 0 && (
          <span
            data-testid="room-back-badge"
            className="ml-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums"
            style={{ background: 'var(--color-danger)', color: 'var(--color-bg)' }}
          >
            {backBadge}
          </span>
        )}
      </Button>
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <h1 className="m-0 truncate text-[15px] font-semibold" data-testid="room-title">
          {title}
        </h1>
        {chainText && (
          <div
            className="truncate text-[12px] text-[var(--color-text-dim)]"
            data-testid="room-objective"
            title={chainText}
          >
            {chainText}
          </div>
        )}
      </div>
      <Button variant="ghost" className={COMPACT} onClick={onSeeMap} data-testid="room-see-map">
        Ver no mapa
      </Button>
      <Button
        variant="ghost"
        className={COMPACT}
        onClick={onFeatures}
        aria-haspopup="dialog"
        aria-label={`Features (Ctrl+\`), ${needsYou} precisa de você`}
        title="Trocar de feature (Ctrl+`)"
        data-testid="room-features"
      >
        Features <Kbd>Ctrl</Kbd>
        <Kbd>`</Kbd>
        <span
          data-testid="room-features-badge"
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums"
          style={
            needsYou > 0
              ? { background: 'var(--color-danger)', color: 'var(--color-bg)' }
              : {
                  background: 'var(--color-surface-2)',
                  color: 'var(--color-text-dim)',
                  boxShadow: 'inset 0 0 0 1px var(--color-border)',
                }
          }
        >
          {needsYou}
        </span>
      </Button>
      <Button
        variant="ghost"
        className={COMPACT}
        disabled={!canDelegate}
        title={canDelegate ? 'Criar filha' : 'Uma filha precisa de uma mãe'}
        onClick={onNewChild}
        aria-haspopup="dialog"
        data-testid="room-new-child"
      >
        + Filha
      </Button>
      <Button
        variant="ghost"
        className={COMPACT}
        onClick={onStartMother}
        aria-haspopup="dialog"
        data-testid="room-start-mother"
      >
        ＋ Iniciar sessão-mãe
      </Button>
    </header>
  )
}
