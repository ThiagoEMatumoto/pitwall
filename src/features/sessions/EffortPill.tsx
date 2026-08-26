import { useState } from 'react'
import { ChevronDown, Clock, Gauge } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Menu, type MenuSection } from '@/components/ui/Menu'
import { EFFORT_LEVELS, type EffortLevel } from './ModelPill'
import { pillDensity } from './pill-density'
import { effortStyle } from './pill-state'
import type { PanelTier } from './use-panel-tier'

interface SectionsArgs {
  /** Nível de esforço ativo da sessão (null = ainda não definido). */
  effort: EffortLevel | null
  /** Troca enfileirada enquanto a sessão estava ocupada, aguardando o próximo idle. */
  pending?: EffortLevel
  /** Modelo suporta xhigh → habilita o ultracode no menu. */
  xhighCapable: boolean
  /** `/effort ultracode` ativo nesta sessão (sobrepõe o nível exibido). */
  ultracodeActive: boolean
  /** Aceita os níveis de --effort + o pseudo-nível nativo 'ultracode'. */
  onSelect: (level: EffortLevel | 'ultracode') => void
}

interface Props extends SectionsArgs {
  /** Sessão ociosa — único estado seguro pra injetar /effort. Default true. */
  canSwitch?: boolean
  /** Densidade do rodapé (pillDensity): wide = rótulo + caret; mid = rótulo sem
   *  caret; narrow = só o ícone — e aí o valor migra pro title/aria-label. */
  tier: PanelTier
  /** Frase da troca enfileirada/em aplicação. Presente → ponto no canto + title. */
  pendingHint?: string
}

// Itens do menu de esforço. Exportado porque no painel estreito o controle migra
// pro menu "⋯" do ComposerToolbar: a lista de opções não pode existir em dois
// lugares, senão uma delas envelhece sozinha.
export function effortSections({
  effort,
  pending,
  xhighCapable,
  ultracodeActive,
  onSelect,
}: SectionsArgs): MenuSection[] {
  const shown = pending ?? effort
  return [
    // ultracode no TOPO, só quando o modelo suporta xhigh.
    ...(xhighCapable
      ? [
          {
            title: 'Ultra',
            items: [
              {
                label: 'ultracode',
                active: ultracodeActive,
                onClick: () => onSelect('ultracode'),
              },
            ],
          },
        ]
      : []),
    {
      title: 'Esforço',
      items: EFFORT_LEVELS.map((level) => ({
        label: level,
        active: !ultracodeActive && shown === level,
        onClick: () => onSelect(level),
      })),
    },
  ]
}

// Controle de esforço como pill próprio, ao lado do ModelPill (estilo barra do
// Claude Desktop). A cor segue o nível ATIVO via effortStyle (fonte única de
// cor-por-estado). 'ultracode' não é um valor de --effort: é o mecanismo nativo
// `/effort ultracode`, só disponível quando o modelo suporta xhigh — por isso
// entra no TOPO do menu (violeta) e só aparece quando `xhighCapable`.
export function EffortPill({
  effort,
  pending,
  xhighCapable,
  ultracodeActive,
  onSelect,
  canSwitch = true,
  tier,
  pendingHint,
}: Props) {
  const [open, setOpen] = useState(false)

  const shown = pending ?? effort
  const hasPending = pending !== undefined

  // ultracode ativo vence o nível numérico na exibição do pill.
  const activeStyle = ultracodeActive
    ? effortStyle('ultracode')
    : shown
      ? effortStyle(shown)
      : null

  const label = ultracodeActive ? 'ultracode' : (shown ?? 'esforço…')
  const textClass = activeStyle?.text ?? 'text-[var(--color-text-dim)]'
  const iconClass = hasPending ? 'text-[var(--color-accent)]' : textClass
  const LeadingIcon = hasPending ? Clock : (activeStyle?.icon ?? Gauge)

  const sections = effortSections({ effort, pending, xhighCapable, ultracodeActive, onSelect })

  const { pad, showCaret, showLabel } = pillDensity(tier)
  // No narrow o rótulo some da tela — o valor tem de migrar pro nome acessível,
  // senão o controle fica mudo pra quem usa leitor de tela. Com o rótulo
  // visível, NÃO setar aria-label (o nome acessível tem de conter o texto visto).
  const hiddenValue = showLabel ? null : `Esforço: ${label}`
  const baseTitle = canSwitch
    ? 'Trocar o esforço desta sessão'
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
        } ${hasPending ? 'border-[var(--color-accent)]/50' : 'border-[var(--color-border)]'} ${textClass}`}
      >
        <Icon as={LeadingIcon} size={11} className={iconClass} />
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
