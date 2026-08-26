import { Loader, Mic, MicOff } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/features/brand'
import { pillDensity } from '../pill-density'
import type { PanelTier } from '../use-panel-tier'
import type { RecorderState } from './voice-recorder-state'

interface Props {
  /** Estado do ditado — mora no Terminal (useVoiceRecorder), não aqui: o atalho
   *  de teclado e este botão precisam do MESMO "Gravando…". */
  state: RecorderState
  onToggle: () => void
  /** Densidade do rodapé: só no narrow o rótulo some (mesma regra dos pills vizinhos). */
  tier: PanelTier
}

// Botão de ditado na barra do composer. Toggle gravar/parar; ao parar, o áudio
// vai pro STT e o texto entra no prompt pra revisão. Mesma linguagem visual dos
// botões vizinhos do ComposerToolbar (Button sm, ícone 11px, texto 10px).
export function MicButton({ state, onToggle, tier }: Props) {
  const { pad, showLabel } = pillDensity(tier)
  const label = (text: string) =>
    showLabel ? <span className="whitespace-nowrap">{text}</span> : null
  // Sem rótulo visível, o texto do estado tem de ir pro nome acessível.
  const aria = (text: string) => (showLabel ? undefined : text)

  if (state.status === 'requesting') {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled
        title="Aguardando o microfone…"
        aria-label={aria('Voz')}
        className={`gap-1 ${pad} py-0.5 text-[10px]`}
      >
        <Icon as={Loader} size={11} className="animate-spin" />
        {label('Voz')}
      </Button>
    )
  }

  if (state.status === 'recording') {
    return (
      <Button
        variant="danger"
        size="sm"
        onClick={onToggle}
        title="Parar a gravação e transcrever"
        aria-label={aria('Gravando…')}
        className={`gap-1 ${pad} py-0.5 text-[10px]`}
      >
        <Icon as={Mic} size={11} className="animate-pulse" />
        {label('Gravando…')}
      </Button>
    )
  }

  if (state.status === 'transcribing') {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled
        title="Transcrevendo o áudio…"
        aria-label={aria('Transcrevendo…')}
        className={`gap-1 ${pad} py-0.5 text-[10px]`}
      >
        <Icon as={Loader} size={11} className="animate-spin" />
        {label('Transcrevendo…')}
      </Button>
    )
  }

  if (state.status === 'condensing') {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled
        title="Condensando o ditado num prompt limpo…"
        aria-label={aria('Condensando…')}
        className={`gap-1 ${pad} py-0.5 text-[10px]`}
      >
        <Icon as={Loader} size={11} className="animate-spin" />
        {label('Condensando…')}
      </Button>
    )
  }

  if (state.status === 'error') {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggle}
        title={`${state.message} Clique pra tentar de novo.`}
        aria-label={aria('Voz falhou')}
        className={`gap-1 ${pad} py-0.5 text-[10px] text-[var(--color-danger)]`}
      >
        <Icon as={MicOff} size={11} />
        {label('Voz falhou')}
      </Button>
    )
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      title="Ditar por voz — a transcrição entra no prompt sem enviar"
      aria-label={aria('Voz')}
      className={`gap-1 ${pad} py-0.5 text-[10px]`}
    >
      <Icon as={Mic} size={11} />
      {label('Voz')}
    </Button>
  )
}
