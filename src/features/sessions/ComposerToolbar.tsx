import { useEffect, useState } from 'react'
import { Clock, Loader, OctagonX } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/features/brand'
import {
  interruptEnabled,
  interruptLabel,
  interruptState,
  interruptTitle,
} from './interrupt-state'
import type { PermissionMode, SessionActivity } from '../../../shared/types/ipc'
import { ModelPill, type EffortLevel, type ModelAlias } from './ModelPill'
import { EffortPill } from './EffortPill'
import { PermissionPill } from './PermissionPill'
import { isPendingEmpty, type PendingSelection } from './model-queue'
import { usePanelTier } from './use-panel-tier'
import { MicButton } from './voice/MicButton'

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
  /** Recebe o texto ditado/transcrito (MicButton). Ausente = sem o botão de voz. */
  onVoiceText?: (text: string) => void
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
// (sem desabilitar o controle). Slot para o botão de anexar imagem virá à direita.
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
  onVoiceText,
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
  const { ref, tier } = usePanelTier<HTMLDivElement>()
  const compact = tier !== 'wide'

  return (
    <div ref={ref} className="flex items-center gap-2 px-1 pb-1">
      <ModelPill
        activity={activity}
        canSwitch={canSwitch}
        pending={pending}
        onSelectModel={onSelectModel}
        compact={compact}
      />
      <EffortPill
        effort={activeEffort}
        pending={pending.effort}
        xhighCapable={xhighCapable}
        ultracodeActive={ultracodeActive}
        onSelect={onSelectEffort}
        canSwitch={canSwitch}
        compact={compact}
      />
      <PermissionPill
        currentMode={currentMode}
        onCycle={onCyclePermission}
        onSelect={onSelectPermission}
        compact={compact}
      />
      {onInterrupt && (
        <Button
          variant={interrupt === 'armed' ? 'danger' : 'ghost'}
          size="sm"
          disabled={!interruptEnabled(interrupt)}
          onClick={handleInterrupt}
          title={interruptTitle(interrupt)}
          className="gap-1 px-2 py-0.5 text-[10px]"
        >
          <Icon as={interrupt === 'sent' ? Loader : OctagonX} size={11} className={interrupt === 'sent' ? 'animate-spin' : ''} />
          <span className="whitespace-nowrap">{interruptLabel(interrupt)}</span>
        </Button>
      )}
      {onVoiceText && <MicButton onText={onVoiceText} />}
      {hasPending &&
        (canSwitch ? (
          // Sessão ficou ociosa com troca pendente: a injeção dispara agora —
          // feedback de "aplicando" em vez de a transição ser tácita.
          <span
            className="flex items-center gap-1 text-[10px] text-[var(--color-accent)]"
            title="A sessão ficou ociosa — aplicando a troca agora"
          >
            <Icon as={Loader} size={11} className="animate-spin" />
            aplicando {pendingLabel(pending)}…
          </span>
        ) : (
          <span
            className="flex items-center gap-1 text-[10px] text-[var(--color-text-dim)]"
            title="A sessão está ocupada — a troca será injetada assim que ela ficar ociosa"
          >
            <Icon as={Clock} size={11} className="text-[var(--color-accent)]" />
            {pendingLabel(pending)} será aplicado quando ociosa
          </span>
        ))}
    </div>
  )
}
