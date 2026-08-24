import { Loader, Mic, MicOff } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/features/brand'
import { useVoiceRecorder } from './useVoiceRecorder'

interface Props {
  // Recebe o texto transcrito — o pai insere no composer (nunca envia direto).
  onText: (text: string) => void
}

// Botão de ditado na barra do composer. Toggle gravar/parar; ao parar, o áudio
// vai pro STT e o texto entra no prompt pra revisão. Mesma linguagem visual dos
// botões vizinhos do ComposerToolbar (Button sm, ícone 11px, texto 10px).
export function MicButton({ onText }: Props) {
  const { state, toggle } = useVoiceRecorder(onText)

  if (state.status === 'recording') {
    return (
      <Button
        variant="danger"
        size="sm"
        onClick={toggle}
        title="Parar a gravação e transcrever"
        className="gap-1 px-2 py-0.5 text-[10px]"
      >
        <Icon as={Mic} size={11} className="animate-pulse" />
        <span className="whitespace-nowrap">Gravando…</span>
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
        className="gap-1 px-2 py-0.5 text-[10px]"
      >
        <Icon as={Loader} size={11} className="animate-spin" />
        <span className="whitespace-nowrap">Transcrevendo…</span>
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
        className="gap-1 px-2 py-0.5 text-[10px] text-[var(--color-danger)]"
      >
        <Icon as={MicOff} size={11} />
        <span className="whitespace-nowrap">Voz falhou</span>
      </Button>
    )
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      title="Ditar por voz — a transcrição entra no prompt sem enviar"
      className="gap-1 px-2 py-0.5 text-[10px]"
    >
      <Icon as={Mic} size={11} />
      <span className="whitespace-nowrap">Voz</span>
    </Button>
  )
}
