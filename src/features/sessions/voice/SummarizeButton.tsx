import { useEffect, useRef, useState } from 'react'
import { Loader, ScrollText } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/features/brand'
import { voiceApi } from '@/lib/ipc'

interface Props {
  ccSessionId: string
  /** Tier compact do rodapé: só ícone, sem rótulo (mesma regra dos pills vizinhos). */
  compact?: boolean
}

type State = { status: 'idle' } | { status: 'running' } | { status: 'error'; message: string }

// Erro some sozinho: a mensagem é transiente (lock em voo, turno sem texto) e
// não pode ficar pra sempre ocupando o rodapé.
const ERROR_AUTOCLEAR_MS = 5_000

// Botão "Resumir": resume o último turno AGORA, sem depender do toggle de
// resumo automático (voice:summarize-now bypassa o gate; o resultado chega
// pelo mesmo broadcast e aparece no SummaryChip). Visível mesmo sem resumo
// nenhum ainda — é o caminho de entrada do fluxo sob demanda.
export function SummarizeButton({ ccSessionId, compact }: Props) {
  const [state, setState] = useState<State>({ status: 'idle' })
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (state.status !== 'error') return
    const timer = setTimeout(() => setState({ status: 'idle' }), ERROR_AUTOCLEAR_MS)
    return () => clearTimeout(timer)
  }, [state])

  async function run() {
    if (state.status === 'running') return
    setState({ status: 'running' })
    const res = await voiceApi.summarizeNow(ccSessionId)
    if (!mountedRef.current) return
    setState(res.ok ? { status: 'idle' } : { status: 'error', message: res.error })
  }

  const pad = compact ? 'px-1.5' : 'px-2'
  const label = (text: string) =>
    compact ? null : <span className="whitespace-nowrap">{text}</span>

  if (state.status === 'running') {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled
        title="Resumindo o último turno…"
        className={`gap-1 ${pad} py-0.5 text-[10px]`}
      >
        <Icon as={Loader} size={11} className="animate-spin" />
        {label('Resumindo…')}
      </Button>
    )
  }

  if (state.status === 'error') {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void run()}
          title={`${state.message} Clique pra tentar de novo.`}
          className={`gap-1 ${pad} py-0.5 text-[10px] text-[var(--color-danger)]`}
        >
          <Icon as={ScrollText} size={11} />
          {label('Resumir')}
        </Button>
        {/* Texto visível mesmo no tier compact: erro só em title/cor é invisível. */}
        <span
          role="status"
          title={state.message}
          className="max-w-[180px] truncate text-[10px] text-[var(--color-danger)]"
        >
          {state.message}
        </span>
      </span>
    )
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void run()}
      title="Resumir o último turno agora — o resumo aparece no chip acima do composer"
      className={`gap-1 ${pad} py-0.5 text-[10px]`}
    >
      <Icon as={ScrollText} size={11} />
      {label('Resumir')}
    </Button>
  )
}
