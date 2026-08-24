import { Loader, Mic, MicOff } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/features/brand'
import { useVoiceRecorder } from './useVoiceRecorder'

interface Props {
  // Recebe o texto transcrito — o pai insere no composer (nunca envia direto).
  onText: (text: string) => void
  /** Tier compact do rodapé: só ícone, sem rótulo (mesma regra dos pills vizinhos). */
  compact?: boolean
}

// Botão de ditado na barra do composer. Toggle gravar/parar; ao parar, o áudio
// vai pro STT e o texto entra no prompt pra revisão. Mesma linguagem visual dos
// botões vizinhos do ComposerToolbar (Button sm, ícone 11px, texto 10px).
export function MicButton({ onText, compact }: Props) {
  const { state, toggle } = useVoiceRecorder(onText)
  const pad = compact ? 'px-1.5' : 'px-2'
  const label = (text: string) =>
    compact ? null : <span className="whitespace-nowrap">{text}</span>

  if (state.status === 'requesting') {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled
        title="Aguardando o microfone…"
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
        onClick={toggle}
        title="Parar a gravação e transcrever"
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
        onClick={toggle}
        title={`${state.message} Clique pra tentar de novo.`}
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
      onClick={toggle}
      title="Ditar por voz — a transcrição entra no prompt sem enviar"
      className={`gap-1 ${pad} py-0.5 text-[10px]`}
    >
      <Icon as={Mic} size={11} />
      {label('Voz')}
    </Button>
  )
}
