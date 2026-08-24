import { AlertTriangle } from 'lucide-react'

import { Icon } from '@/components/ui/Icon'

import type { SessionActivity } from '../../../shared/types/ipc'
import { contextUsage, formatContextUsage } from './model-context-limits'
import { modelAliasFromId } from './ModelPill'

interface Props {
  activity: SessionActivity | null
  // Variante do hero de linha única: só "NN%" colorido, detalhe completo no tooltip.
  compact?: boolean
  // Abre o diálogo de passagem de bastão. Ausente = o caller não sabe passar o
  // bastão (ex.: superfícies sem sessão viva por baixo) e a ação some da vista.
  onPassBaton?: () => void
}

// Cor por % do uso da janela (SPEC): <70% neutro (text-dim), 70-89% warning,
// >=90% danger. Devolve a var de tema usada tanto no texto quanto no preenchimento
// da barra — mantém a barra e os números sempre na mesma cor de estado.
function colorForPct(pct: number): string {
  if (pct >= 90) return 'var(--color-danger)'
  if (pct >= 70) return 'var(--color-warning)'
  return 'var(--color-text-dim)'
}

// Thresholds mais sensíveis (60/85) que a variante completa (70/90) porque no
// hero compacto a cor é o ÚNICO sinal — não há barra nem contagem absoluta.
function compactColorForPct(pct: number): string {
  if (pct > 85) return 'var(--color-danger)'
  if (pct >= 60) return 'var(--color-warning)'
  return 'var(--color-text-dim)'
}

// Monitor da janela de contexto no header da pane (ambos os modos): barra de
// progresso colorida por estado + "95k / 1.0M · 10%". Lê tokens.context
// (cache_read + input da última resposta) e o modelo do broadcast session:activity.
// Não renderiza nada sem tokens+modelo (sessão sem 1ª resposta ainda).
// Aviso proativo a partir de 80% (ícone + realce de fundo) e, >=85%, as DUAS
// saídas possíveis: /compact (condensa o histórico desta mesma conversa) e passar
// o bastão (sessão nova, contexto limpo, herdando o briefing). Uma não substitui
// a outra — por isso aparecem lado a lado, cada uma dizendo o que faz.
export function ContextUsageIndicator({ activity, compact, onPassBaton }: Props) {
  const model = activity?.model ?? null
  const usage = contextUsage({ tokens: activity?.tokens, model })
  if (!usage) return null

  const color = colorForPct(usage.pct)
  const proactive = usage.pct >= 80
  const showCompact = usage.pct >= 85

  const alias = modelAliasFromId(model)
  const modelLabel = alias
    ? alias[0].toUpperCase() + alias.slice(1)
    : (model ?? 'modelo desconhecido').replace(/^claude-/, '')
  const tooltip = `Janela de contexto · ${modelLabel} · limite ${usage.limit.toLocaleString(
    'pt-BR',
  )} tokens · usados ${usage.used.toLocaleString('pt-BR')} (${usage.pct}%)`

  if (compact) {
    // Nada da variante completa se perde: barra/contagem viram tooltip, e a dica
    // de /compact (>=85%) migra pro mesmo tooltip.
    // Aqui só cabe "NN%": as duas saídas viram texto de tooltip (o botão do
    // bastão fica no header da sessão, que tem largura pra ele).
    const compactTooltip = showCompact
      ? `${tooltip} — contexto quase cheio: /compact condensa o histórico desta conversa; passar o bastão abre uma sessão limpa que herda o trabalho (botão no header da sessão)`
      : tooltip
    return (
      <span
        className="whitespace-nowrap text-[10px] tabular-nums"
        style={{ color: compactColorForPct(usage.pct) }}
        title={compactTooltip}
        aria-label={compactTooltip}
      >
        {usage.pct}%
      </span>
    )
  }

  return (
    <span
      className={`flex items-center gap-1.5 whitespace-nowrap rounded text-[10px] tabular-nums ${
        proactive ? 'px-1.5 py-0.5' : ''
      }`}
      style={{
        color,
        background: proactive ? `color-mix(in srgb, ${color} 14%, transparent)` : undefined,
      }}
      title={tooltip}
    >
      {proactive && <Icon as={AlertTriangle} size={11} className="shrink-0" />}
      <span className="text-[var(--color-text-dim)]">ctx</span>
      <span
        className="relative h-1.5 w-12 shrink-0 overflow-hidden rounded-full"
        style={{ background: 'color-mix(in srgb, var(--color-border) 70%, transparent)' }}
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
          style={{ width: `${usage.pct}%`, background: color }}
        />
      </span>
      <span>{formatContextUsage(usage)}</span>
      {showCompact && (
        <span
          className="rounded border px-1 py-px text-[9px] font-medium"
          style={{ borderColor: color, color }}
          title="Contexto quase cheio — rode /compact na sessão para condensar o histórico DESTA conversa (mesma sessão, mais curta)"
        >
          /compact
        </span>
      )}
      {showCompact && onPassBaton && (
        <button
          type="button"
          data-testid="ctx-pass-baton"
          onClick={onPassBaton}
          className="rounded border px-1 py-px text-[9px] font-medium hover:bg-[var(--color-surface-2)]"
          style={{ borderColor: color, color }}
          title="Passar o bastão — sobe uma sessão NOVA (contexto limpo) com um briefing do que já foi feito. Esta continua viva; nada é condensado."
        >
          passar o bastão
        </button>
      )}
    </span>
  )
}
