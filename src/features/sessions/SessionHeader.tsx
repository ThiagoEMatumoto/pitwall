import { useState } from 'react'
import {
  AlertCircle,
  Circle,
  Flag,
  MessageSquare,
  Minus,
  Pencil,
  Power,
  SquareTerminal,
  Target,
  Users,
} from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { renderProjectIcon } from '@/components/ui/projectIcon'
import { LivenessChip } from '@/features/features/LivenessChip'
import { navigateToFeature } from '@/lib/nav'
import { usePanelTier } from './use-panel-tier'
import { MeasureBlocks } from '@/features/brand/MeasureBlocks'
import { contextUsage, formatContextUsage } from './model-context-limits'
import { formatRelative, statusDotView } from './status-view'
import type { PaneMode } from '@/store/appStore'
import type { SessionFeature } from './useSessionFeature'
import type { SessionActivity } from '../../../shared/types/ipc'

interface Props {
  projectName: string
  projectIcon?: string | null
  projectColor?: string | null
  repoLabel: string
  repoPath: string
  // Precedência de nome já resolvida pelo Terminal.tsx (activity?.name > title > repoLabel).
  displayTitle: string
  // Valor pra semear o draft de rename — sem fallback pro label do repo
  // (activity?.name ?? title ?? ''), diferente de displayTitle.
  nameValue: string
  isNamed: boolean
  canRename: boolean
  onCommitRename: (next: string) => void
  exited: boolean
  activity: SessionActivity | null
  now: number
  claudeNotFound: boolean
  exitCode: number | null
  error: string | null
  mode: PaneMode
  onToggleMode?: () => void
  onMinimize: () => void
  onEndSession: () => void
  // Passar o bastão: sobe uma sessão LIMPA com o briefing destilado desta. Fica
  // sempre à mão (não só com o contexto no fim) porque trocar de sessão também é
  // decisão deliberada — ex.: virar de assunto sem arrastar a conversa antiga.
  // Ausente = o caller não sabe passar o bastão e a ação some.
  onPassBaton?: () => void
  // Tornar sessão filha: declara esta sessão filha de outra e a manda pro painel
  // da equipe. Ausente = o caller não sabe adotar e a ação some.
  onAdopt?: () => void
  // Motivo de a adoção estar indisponível (ex.: sem transcript no disco). Com
  // motivo, o botão aparece DESABILITADO e explica no tooltip — some sem dizer
  // por quê é o que faz o usuário achar que o app está quebrado.
  adoptDisabledReason?: string | null
  // Feature desta sessão. Presente = o header ganha o chip de volta pro dossiê
  // (Features e terminais são áreas exclusivas; sem isto a ida é só de ida).
  feature?: SessionFeature | null
}

// Header de cada sessão em UMA linha calma:
//   [dot status] [ícone] Projeto · título …… [NN%] [toggle ⇄] [Minus] [Power]
// Regra de ouro: nenhuma informação se perde — o que saiu da vista (label de
// status, tempo relativo, path do repo, detalhe de contexto) vive em
// tooltip/aria-label. Degrada por tier de largura REAL do painel (não da
// janela), da direita pra esquerda:
// - wide/mid: tudo (splits de 3-4 panes caem no mid e o % ainda cabe).
// - narrow: somem % + toggle + título/rename; ficam dot + ícone + Minus + Power.
export function SessionHeader({
  projectName,
  projectIcon,
  projectColor,
  repoLabel,
  repoPath,
  displayTitle,
  nameValue,
  isNamed: _isNamed,
  canRename,
  onCommitRename,
  exited,
  activity,
  now,
  claudeNotFound,
  exitCode,
  error,
  mode,
  onToggleMode,
  onMinimize,
  onEndSession,
  onPassBaton,
  onAdopt,
  adoptDisabledReason = null,
  feature = null,
}: Props) {
  const { ref, tier } = usePanelTier<HTMLDivElement>()

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  function commitRename() {
    setEditing(false)
    const next = draft.replace(/[\r\n]+/g, ' ').trim()
    if (next.length === 0) return
    onCommitRename(next)
  }

  const dot = statusDotView(activity?.status)
  const relTime = activity?.lastActivityAt ? formatRelative(now - activity.lastActivityAt) : null
  // Tooltip carrega tudo que era texto visível: label de status, tempo relativo
  // e o título da atividade corrente reportado pelo claude.
  const dotTooltip = [dot.label, relTime, activity?.title].filter(Boolean).join(' · ')
  // Reusa o cálculo puro de contexto (mesma fonte do ContextUsageIndicator):
  // tokens.context / limite do modelo → pct. A cor sai do limiar do MeasureBlocks.
  const ctxUsage = contextUsage({ tokens: activity?.tokens, model: activity?.model ?? null })
  // Mesmo limiar do /compact (>=85%): daqui pra cima a janela está no fim e as
  // duas saídas passam a ser decisão do minuto, não da semana. É AQUI que o
  // usuário olha (o header é a única superfície de contexto que chega à tela),
  // então é aqui que o bastão sai do discreto e ganha realce ao lado do ctx.
  const ctxCritical = (ctxUsage?.pct ?? 0) >= 85

  return (
    <div
      ref={ref}
      className="group flex h-[33px] shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] border-b-white/[0.06] bg-gradient-to-b from-[var(--color-surface-2)]/70 to-[var(--color-surface)]/50 px-3.5 text-xs"
      style={{ boxShadow: `inset 2px 0 0 ${projectColor ?? 'var(--color-accent)'}` }}
    >
      <div className="flex min-w-0 items-center gap-2">
        {!exited && (
          <span
            role="status"
            title={dotTooltip}
            aria-label={dotTooltip}
            className={`shrink-0 ${dot.className}`}
          >
            <span
              className={`block h-2 w-2 rounded-full bg-current shadow-[0_0_4px_currentColor] ${
                dot.pulse ? 'animate-pulse' : ''
              }`}
            />
          </span>
        )}
        {projectName && (
          <span
            className="shrink-0"
            style={{ color: projectColor ?? 'var(--color-accent)' }}
          >
            {renderProjectIcon(projectIcon)}
          </span>
        )}
        {tier !== 'narrow' && feature && (
          <button
            type="button"
            data-testid="header-feature-chip"
            onClick={() => navigateToFeature(feature.id)}
            title={`Voltar para a feature: ${feature.title}`}
            aria-label={`Voltar para a feature ${feature.title}`}
            className="flex min-w-0 shrink items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[10px] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
          >
            <Icon as={Target} size={10} />
            <span className="max-w-32 truncate">{feature.title}</span>
            {feature.liveness && (
              <LivenessChip
                liveness={feature.liveness}
                lastActivityAt={feature.lastActivityAt}
                issues={feature.issues}
              />
            )}
          </button>
        )}
        {tier !== 'narrow' &&
          (editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setEditing(false)
              }}
              placeholder={repoLabel}
              className="w-40 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 py-0.5 font-medium outline-none focus:border-[var(--color-accent)]"
            />
          ) : (
            <>
              {/* Path saiu da vista: vive no tooltip do nome e o clique segue copiando. */}
              <button
                type="button"
                onClick={() => {
                  if (repoPath) void navigator.clipboard.writeText(repoPath)
                }}
                title={repoPath ? `${repoPath} — clique para copiar` : undefined}
                className="min-w-0 truncate text-left font-medium hover:text-[var(--color-accent)]"
              >
                {projectName && (
                  <>
                    <span className="text-[var(--color-text-dim)]">{projectName}</span>
                    <span className="text-[var(--color-border)]"> · </span>
                  </>
                )}
                {repoLabel && repoLabel !== displayTitle && (
                  <>
                    <span className="text-[var(--color-text-dim)]">{repoLabel}</span>
                    <span className="text-[var(--color-border)]"> / </span>
                  </>
                )}
                {displayTitle}
              </button>
              {/* Lápis só no hover do header — rename continua acessível sem poluir. */}
              <button
                type="button"
                disabled={!canRename}
                onClick={() => {
                  setDraft(nameValue)
                  setEditing(true)
                }}
                title={canRename ? 'Renomear sessão' : 'Aguarde a sessão ficar ociosa pra renomear'}
                aria-label="Renomear sessão"
                className="shrink-0 text-[var(--color-text-dim)] opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 enabled:hover:text-[var(--color-accent)] disabled:cursor-not-allowed"
              >
                <Icon as={Pencil} size={12} />
              </button>
            </>
          ))}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-[var(--color-text-dim)]">
        {exited &&
          tier !== 'narrow' &&
          (claudeNotFound ? (
            <span className="flex items-center gap-1 text-[var(--color-danger)]">
              <Icon as={AlertCircle} size={13} />
              claude não encontrado
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[var(--color-danger)]">
              <Icon as={Circle} size={9} className="fill-current" />
              encerrada ({exitCode ?? '?'})
            </span>
          ))}
        {error && !claudeNotFound && (
          <span
            className="flex items-center gap-1 text-[var(--color-danger)]"
            title={tier === 'narrow' ? error : undefined}
          >
            <Icon as={AlertCircle} size={13} />
            {tier !== 'narrow' && error}
          </span>
        )}
        {/* Uso de contexto compacto (só NN%); detalhe completo no tooltip. Cabe
            até no mid (~36px; splits de 3-4 panes caem aqui) — some só no
            narrow, junto com o toggle. */}
        {!exited && tier !== 'narrow' && ctxUsage && (
          <div
            title={`Janela de contexto · ${formatContextUsage(ctxUsage)}`}
            className="flex shrink-0 items-center"
          >
            <MeasureBlocks label="ctx" percent={ctxUsage.pct} value={`${ctxUsage.pct}%`} />
          </div>
        )}
        {/* Bastão: some no narrow junto com o toggle (mesma regra de degradação)
            e com a sessão encerrada — sem PTY viva não há transcript a destilar.
            Fica colado no ctx de propósito: acima de 85% os dois formam um par
            ("acabando" + "o que fazer a respeito"). O tooltip é o lugar onde a
            distinção pro /compact é lida, então ele muda com o estado. */}
        {!exited && tier !== 'narrow' && onPassBaton && (
          <button
            type="button"
            onClick={onPassBaton}
            data-testid="header-pass-baton"
            data-critical={ctxCritical ? 'true' : 'false'}
            title={
              ctxCritical
                ? 'Contexto quase cheio — passar o bastão sobe uma sessão NOVA, de contexto limpo, com um briefing desta. Diferente de /compact, que condensa o histórico desta mesma conversa. Esta sessão continua viva.'
                : 'Passar o bastão — sobe uma sessão nova, de contexto limpo, com um briefing desta. Esta continua viva (diferente de /compact, que condensa esta mesma conversa).'
            }
            aria-label={ctxCritical ? 'Passar o bastão — contexto quase cheio' : 'Passar o bastão'}
            className={
              ctxCritical
                ? 'flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium'
                : 'rounded p-1 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-accent)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)]'
            }
            style={
              ctxCritical
                ? {
                    borderColor: 'var(--color-warning)',
                    color: 'var(--color-warning)',
                    background: 'color-mix(in srgb, var(--color-warning) 14%, transparent)',
                  }
                : undefined
            }
          >
            <Icon as={Flag} size={13} />
            {ctxCritical && <span>bastão</span>}
          </button>
        )}
        {/* Adotar: a sessão vira filha de outra e passa a viver no painel da
            equipe. Reinicia o processo (o apelido e o accept-inbound só se fixam
            no exec) — o diálogo avisa antes de confirmar. */}
        {!exited && tier !== 'narrow' && onAdopt && (
          <button
            type="button"
            onClick={onAdopt}
            disabled={!!adoptDisabledReason}
            title={
              adoptDisabledReason ??
              'Tornar sessão filha — adota esta sessão sob uma mãe e a manda pro painel da equipe (reinicia a sessão; o histórico volta)'
            }
            aria-label="Tornar sessão filha"
            className="rounded p-1 hover:bg-[var(--color-surface-2)] enabled:hover:text-[var(--color-accent)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon as={Users} size={13} />
          </button>
        )}
        {/* Toggle Terminal⇄Chat em 1 ícone: mostra o modo DESTINO. */}
        {onToggleMode && tier !== 'narrow' && (
          <button
            type="button"
            onClick={onToggleMode}
            title={
              mode === 'terminal'
                ? 'Mudar para Chat — transcript renderizado (PTY segue vivo por baixo)'
                : 'Mudar para Terminal — terminal cru (PTY)'
            }
            aria-label={mode === 'terminal' ? 'Mudar para Chat' : 'Mudar para Terminal'}
            className="rounded p-1 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-accent)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)]"
          >
            <Icon as={mode === 'terminal' ? MessageSquare : SquareTerminal} size={13} />
          </button>
        )}
        {/* Ícones consistentes com as tabs (lucide): Minus = minimizar, Power =
            encerrar (hover danger). Tooltip/aria-label preservam o texto antigo. */}
        <button
          type="button"
          onClick={onMinimize}
          title="Minimizar — mantém a sessão rodando em background, acessível no strip de sessões"
          aria-label="Minimizar"
          className="rounded p-1 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)]"
        >
          <Icon as={Minus} size={13} />
        </button>
        <button
          type="button"
          onClick={onEndSession}
          disabled={exited}
          title="Encerrar o processo claude e fechar a sessão (some do strip)"
          aria-label="Encerrar"
          className="rounded p-1 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-danger)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-danger)] disabled:opacity-40"
        >
          <Icon as={Power} size={13} />
        </button>
      </div>
    </div>
  )
}
