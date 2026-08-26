import { useEffect, useState, type ReactNode } from 'react'
import { Loader, MoreHorizontal, OctagonX } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Menu, type MenuItem, type MenuSection } from '@/components/ui/Menu'
import { Button } from '@/features/brand'
import { interruptEnabled, interruptLabel, interruptState, interruptTitle } from './interrupt-state'
import type { PermissionMode, SessionActivity } from '../../../shared/types/ipc'
import { ModelPill, type EffortLevel, type ModelAlias } from './ModelPill'
import { EffortPill, effortSections } from './EffortPill'
import { PermissionPill, permissionSection } from './PermissionPill'
import { COMPOSER_TIERS, composerToolbarLayout, type ToolbarControl } from './composer-layout'
import { isPendingEmpty, type PendingSelection } from './model-queue'
import { usePanelTier } from './use-panel-tier'
import { pillDensity } from './pill-density'
import { AutoSummaryToggle } from './voice/AutoSummaryToggle'
import { MicButton } from './voice/MicButton'
import { SummarizeButton } from './voice/SummarizeButton'
import type { SummarizeState } from './voice/useSummarizeNow'
import type { RecorderState } from './voice/voice-recorder-state'

interface Props {
  activity: SessionActivity | null
  /** Sessão ociosa — único estado em que é seguro injetar /model | /effort. */
  canSwitch: boolean
  /** Troca enfileirada enquanto a sessão está ocupada. */
  pending: PendingSelection
  /** Nível de esforço ATIVO da sessão (rastreado pelo que foi injetado). */
  activeEffort: EffortLevel | null
  /** Modelo ativo suporta xhigh → habilita 'ultracode' no menu do EffortPill. */
  xhighCapable: boolean
  /** `/effort ultracode` ativo nesta sessão (sobrepõe o nível exibido). */
  ultracodeActive: boolean
  /** Modo de permissão ATIVO, refletido do rodapé da TUI. null = padrão seguro. */
  currentMode: PermissionMode | null
  onSelectModel: (alias: ModelAlias) => void
  onSelectEffort: (level: EffortLevel | 'ultracode') => void
  /** Avança um passo do ciclo de permissão (envia Shift+Tab ao PTY). Ausente = sem o ciclo. */
  onCyclePermission?: () => void
  /** Seleção direta de modo: "pula" até o alvo ciclando Shift+Tab até o modo parseado bater. */
  onSelectPermission?: (mode: PermissionMode) => void
  /** Interrompe o claude (envia Ctrl+C ao PTY). Ausente = sem o botão. */
  onInterrupt?: () => void
  /** Ditado por voz — o estado mora no Terminal. Ausente = sem o botão de voz. */
  voice?: { state: RecorderState; toggle: () => void }
  /** Resumo sob demanda — o estado mora no Terminal. Ausente = sem o controle. */
  summarize?: { state: SummarizeState; run: () => void }
  /** Resumo automático — o estado mora no Terminal. Ausente = sem o controle. */
  autoSummary?: { enabled: boolean | null; toggle: () => void }
}

function pendingLabel(pending: PendingSelection): string {
  const parts: string[] = []
  if (pending.model) parts.push(pending.model)
  if (pending.effort) parts.push(pending.effort)
  if (pending.ultracode) parts.push('ultracode')
  return parts.join(' · ')
}

// Barra de controles do composer: dois controles distintos (Modelo · Esforço,
// estilo Claude Desktop) + affordance de fila. Os switchers ficam disponíveis
// mesmo com a sessão ocupada — a troca é enfileirada e aplicada no próximo idle
// (sem desabilitar o controle). Com o painel estreito os controles que não cabem
// migram pro menu "⋯" em vez de serem CORTADOS pela borda do pane.
export function ComposerToolbar({
  activity,
  canSwitch,
  pending,
  activeEffort,
  xhighCapable,
  ultracodeActive,
  currentMode,
  onSelectModel,
  onSelectEffort,
  onCyclePermission,
  onSelectPermission,
  onInterrupt,
  voice,
  summarize,
  autoSummary,
}: Props) {
  const hasPending = !isPendingEmpty(pending)
  // Confirmação do Ctrl+C: o efeito não é instantâneo (a CLI só reage no
  // próximo ciclo) e o clique não deixava rastro nenhum. `sent` segura o
  // feedback até a sessão sair de 'working' — ou por 3s, se ela já não estava
  // trabalhando (cancelar um prompt aberto não muda o status).
  const [sent, setSent] = useState(false)
  const interrupt = interruptState({ status: activity?.status, sent })
  useEffect(() => {
    if (!sent) return
    if (activity?.status !== 'working') {
      const id = setTimeout(() => setSent(false), 3000)
      return () => clearTimeout(id)
    }
  }, [sent, activity?.status])
  function handleInterrupt() {
    setSent(true)
    onInterrupt?.()
  }
  // Mede a própria largura (escopado ao rodapé, independente do tier do header) —
  // mesmo hook de ResizeObserver usado no SessionHeader.
  const { ref, tier, width } = usePanelTier<HTMLDivElement>(COMPOSER_TIERS)
  const { pad, showLabel } = pillDensity(tier)
  const [moreOpen, setMoreOpen] = useState(false)

  // A pendência virou um ponto no canto do pill: a frase inteira era o item mais
  // largo da barra e empurrava tudo pra fora do pane. Ela sobrevive no title do
  // pill e num status sr-only — some da tela, não do leitor.
  const pendingHint = hasPending
    ? canSwitch
      ? `Aplicando ${pendingLabel(pending)}…`
      : `${pendingLabel(pending)} será aplicado quando a sessão ficar ociosa`
    : undefined

  // Disponibilidade é filtrada DEPOIS de separar inline/overflow: o layout fala
  // só de largura, e um controle ausente não pode abrir vaga inline pra outro.
  const available: Record<ToolbarControl, boolean> = {
    model: true,
    effort: true,
    permission: true,
    interrupt: Boolean(onInterrupt),
    mic: Boolean(voice),
    summarize: Boolean(summarize),
    autoSummary: Boolean(autoSummary),
  }
  const layout = composerToolbarLayout(tier, width)
  const inline = layout.inline.filter((c) => available[c])
  const overflow = layout.overflow.filter((c) => available[c])

  const nodes: Record<ToolbarControl, ReactNode> = {
    model: (
      <ModelPill
        key="model"
        activity={activity}
        canSwitch={canSwitch}
        pending={pending}
        onSelectModel={onSelectModel}
        tier={tier}
        pendingHint={pending.model !== undefined ? pendingHint : undefined}
      />
    ),
    effort: (
      <EffortPill
        key="effort"
        effort={activeEffort}
        pending={pending.effort}
        xhighCapable={xhighCapable}
        ultracodeActive={ultracodeActive}
        onSelect={onSelectEffort}
        canSwitch={canSwitch}
        tier={tier}
        pendingHint={pending.effort !== undefined || pending.ultracode ? pendingHint : undefined}
      />
    ),
    permission: (
      <PermissionPill
        key="permission"
        currentMode={currentMode}
        onCycle={onCyclePermission}
        onSelect={onSelectPermission}
        tier={tier}
      />
    ),
    interrupt: (
      <Button
        key="interrupt"
        variant={interrupt === 'armed' ? 'danger' : 'ghost'}
        size="sm"
        disabled={!interruptEnabled(interrupt)}
        onClick={handleInterrupt}
        title={interruptTitle(interrupt)}
        // Sem rótulo visível, o estado ('Interrompendo…') tem de ir pro nome acessível.
        aria-label={showLabel ? undefined : interruptLabel(interrupt)}
        className={`gap-1 ${pad} py-0.5 text-[10px]`}
      >
        <Icon
          as={interrupt === 'sent' ? Loader : OctagonX}
          size={11}
          className={interrupt === 'sent' ? 'animate-spin' : ''}
        />
        {showLabel && <span className="whitespace-nowrap">{interruptLabel(interrupt)}</span>}
      </Button>
    ),
    mic: voice ? (
      <MicButton key="mic" state={voice.state} onToggle={voice.toggle} tier={tier} />
    ) : null,
    summarize: summarize ? (
      <SummarizeButton key="summarize" state={summarize.state} onRun={summarize.run} tier={tier} />
    ) : null,
    autoSummary: autoSummary ? (
      <AutoSummaryToggle
        key="autoSummary"
        enabled={autoSummary.enabled}
        onToggle={autoSummary.toggle}
        tier={tier}
      />
    ) : null,
  }

  const summaryItems: MenuItem[] = []
  if (summarize && overflow.includes('summarize')) {
    summaryItems.push({
      label: summarize.state.status === 'running' ? 'Resumindo…' : 'Resumir',
      disabled: summarize.state.status === 'running',
      title:
        summarize.state.status === 'error'
          ? summarize.state.message
          : 'Resumir o último turno agora — o resumo aparece no chip acima do composer',
      onClick: summarize.run,
    })
  }
  if (autoSummary && overflow.includes('autoSummary')) {
    summaryItems.push({
      label: 'Resumo auto',
      active: autoSummary.enabled === true,
      disabled: autoSummary.enabled === null,
      title:
        autoSummary.enabled === null
          ? 'Consultando o estado do resumo automático…'
          : 'Resumo automático do fim de cada turno desta sessão, no chip acima do composer.',
      onClick: autoSummary.toggle,
    })
  }

  const sections: MenuSection[] = [
    ...(overflow.includes('effort')
      ? effortSections({
          effort: activeEffort,
          pending: pending.effort,
          xhighCapable,
          ultracodeActive,
          onSelect: onSelectEffort,
        })
      : []),
    ...(overflow.includes('permission')
      ? [
          permissionSection({
            currentMode,
            onSelect: onSelectPermission,
            onCycle: onCyclePermission,
          }),
        ]
      : []),
    ...(summaryItems.length > 0 ? [{ title: 'Resumo', items: summaryItems }] : []),
  ]

  return (
    <div ref={ref} className="flex items-center gap-2 px-1 pb-1">
      {inline.map((control) => nodes[control])}
      {sections.length > 0 && (
        <Menu
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          sections={sections}
          portal
          align="left"
        >
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            title="Mais controles"
            aria-label="Mais controles"
            className="flex items-center rounded px-1 py-0.5 text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          >
            <Icon as={MoreHorizontal} size={14} />
          </button>
        </Menu>
      )}
      {pendingHint && (
        <span role="status" className="sr-only">
          {pendingHint}
        </span>
      )}
    </div>
  )
}
