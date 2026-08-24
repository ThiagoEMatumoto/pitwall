import { useEffect } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/features/brand'
import { useVoiceModeStore } from './use-voice-mode'
import { stopSpeaking } from './useVoiceSpeaker'

// Toggle do modo voz na barra do composer (pref global voice.mode — a mesma que
// gateia o resumidor no main). Mesma linguagem visual dos botões vizinhos.
export function VoiceModeToggle() {
  const enabled = useVoiceModeStore((s) => s.enabled)
  const load = useVoiceModeStore((s) => s.load)
  const setEnabled = useVoiceModeStore((s) => s.setEnabled)

  useEffect(() => {
    void load()
  }, [load])

  function toggle() {
    const next = !enabled
    // Desligar corta a fala na hora — ninguém desliga pra continuar ouvindo.
    if (!next) stopSpeaking()
    void setEnabled(next)
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      aria-pressed={enabled}
      title={
        enabled
          ? 'Modo voz ligado — o fim de cada turno vira resumo falado na sessão ativa. Clique pra desligar.'
          : 'Modo voz desligado — ligue pra ouvir um resumo falado ao fim de cada turno.'
      }
      className={`gap-1 px-2 py-0.5 text-[10px] ${enabled ? 'text-[var(--color-accent)]' : ''}`}
    >
      <Icon as={enabled ? Volume2 : VolumeX} size={11} />
      <span className="whitespace-nowrap">Modo voz</span>
    </Button>
  )
}
