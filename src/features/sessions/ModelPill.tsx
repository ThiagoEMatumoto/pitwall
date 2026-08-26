import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Clock, Loader, Sparkles } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Menu, type MenuSection } from '@/components/ui/Menu'
import type { SessionActivity } from '../../../shared/types/ipc'
import type { PendingSelection } from './model-queue'
import { pillDensity } from './pill-density'
import type { PanelTier } from './use-panel-tier'
import {
  MODEL_ALIASES,
  MODEL_LABELS,
  modelAliasFromId,
  type ModelAlias,
} from '../../../shared/models'

// Whitelists literais — são a ÚNICA fonte do que pode ser injetado no PTY
// (/model e /effort). Nunca interpolar texto livre nesses comandos. Os aliases
// de modelo derivam do registro canônico em shared/models.ts; re-exportados
// aqui pra manter o ponto de import histórico dos consumidores do pill.
export { MODEL_ALIASES, modelAliasFromId }
export type { ModelAlias }
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

// Troca otimista: se o transcript não confirmar o modelo alvo em 20s, o pill
// reverte pro detectado (a injeção pode ter sido ignorada pelo claude).
const SWITCH_TIMEOUT_MS = 20_000

interface Props {
  activity: SessionActivity | null
  /** Sessão ociosa — único estado em que é seguro injetar /model | /effort. */
  canSwitch: boolean
  /** Troca escolhida enquanto a sessão estava ocupada, aguardando o próximo idle. */
  pending: PendingSelection
  onSelectModel: (alias: ModelAlias) => void
  /** Densidade do rodapé (pillDensity): wide = rótulo + caret; mid = rótulo sem
   *  caret; narrow = só o ícone — e aí o valor migra pro title/aria-label. */
  tier: PanelTier
  /** Frase da troca enfileirada/em aplicação. Presente → ponto no canto + title. */
  pendingHint?: string
}

export function ModelPill({
  activity,
  canSwitch,
  pending,
  onSelectModel,
  tier,
  pendingHint,
}: Props) {
  const [open, setOpen] = useState(false)
  // Alvo da troca otimista de modelo; null = sem troca em voo.
  const [switching, setSwitching] = useState<ModelAlias | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const detected = modelAliasFromId(activity?.model)

  // Confirmação: quando o transcript reporta o modelo alvo, a troca terminou.
  // 'opusplan' nunca aparece em transcripts (a CLI reporta opus no plan mode e
  // sonnet na execução) — qualquer um dos dois confirma a troca; sem isso o
  // pill reverteria após SWITCH_TIMEOUT_MS mesmo com o /model aplicado.
  useEffect(() => {
    const confirmed =
      switching != null &&
      (switching === 'opusplan'
        ? detected === 'opus' || detected === 'sonnet'
        : detected === switching)
    if (confirmed) {
      setSwitching(null)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [switching, detected])

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  function pickModel(alias: ModelAlias) {
    onSelectModel(alias)
    // Otimismo só quando vai injetar agora; em busy a pendência (prop) é a fonte.
    if (canSwitch) {
      setSwitching(alias)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => setSwitching(null), SWITCH_TIMEOUT_MS)
    }
  }

  const hasPending = pending.model !== undefined

  const sections: MenuSection[] = [
    {
      title: 'Modelo',
      items: MODEL_ALIASES.map((alias) => ({
        label: MODEL_LABELS[alias],
        active: (switching ?? pending.model ?? detected) === alias,
        onClick: () => pickModel(alias),
      })),
    },
  ]

  // Label do pill: pendência (busy) > troca em voo > alias detectado > id cru > 'modelo…'.
  let label: string
  let dim = false
  if (pending.model) {
    label = MODEL_LABELS[pending.model]
  } else if (switching) {
    label = MODEL_LABELS[switching]
  } else if (detected) {
    label = MODEL_LABELS[detected]
  } else if (activity?.model) {
    label = activity.model.replace(/^claude-/, '')
  } else {
    label = 'modelo…'
    dim = true
  }

  const { pad, showCaret, showLabel } = pillDensity(tier)
  // No narrow o rótulo some da tela — o valor tem de migrar pro nome acessível,
  // senão o controle fica mudo pra quem usa leitor de tela. Com o rótulo
  // visível, NÃO setar aria-label (o nome acessível tem de conter o texto visto).
  const hiddenValue = showLabel ? null : `Modelo: ${label}`
  const baseTitle = canSwitch
    ? 'Trocar modelo ou esforço desta sessão'
    : 'Sessão ocupada — a troca será aplicada quando ela ficar ociosa'

  return (
    <Menu open={open} onClose={() => setOpen(false)} sections={sections} portal align="left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={[hiddenValue, pendingHint ?? baseTitle].filter(Boolean).join(' — ')}
        aria-label={hiddenValue ?? undefined}
        className={`flex items-center gap-1 rounded-full border py-0.5 text-[10px] transition hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)] ${pad} ${
          pendingHint ? 'relative' : ''
        } ${hasPending ? 'border-[var(--color-accent)]/50' : 'border-[var(--color-border)]'} ${
          dim ? 'text-[var(--color-text-dim)]' : 'text-[var(--color-text)]'
        }`}
      >
        <Icon
          as={switching ? Loader : hasPending ? Clock : Sparkles}
          size={11}
          className={switching ? 'animate-spin' : 'text-[var(--color-accent)]'}
        />
        {showLabel && <span className="whitespace-nowrap">{label}</span>}
        {showCaret && <Icon as={ChevronDown} size={10} className="text-[var(--color-text-dim)]" />}
        {pendingHint && (
          // A frase da pendência era o item mais largo da barra: virou um ponto.
          // Pulsa só quando a troca está sendo aplicada AGORA (sessão ociosa).
          <span
            aria-hidden
            className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] ${
              canSwitch ? 'animate-pulse' : ''
            }`}
          />
        )}
      </button>
    </Menu>
  )
}
