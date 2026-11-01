import { OctagonX } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { MarkdownViewer } from '@/components/ui/MarkdownViewer'

interface Props {
  role: 'user' | 'assistant'
  text: string
  // Eco otimista ainda não reconciliado com o disco — renderiza esmaecido.
  pending?: boolean
  // Turno cortado por Ctrl+C: o texto abaixo está pela metade. Só assistant.
  interrupted?: boolean
}

export function MessageBubble({ role, text, pending, interrupted }: Props) {
  if (role === 'user') {
    // Bolha do usuário: à direita, tinta da marca sólida e discreta, cauda
    // inferior-direita (radius 16 16 4 16).
    return (
      <div className="flex justify-end">
        <div
          className={`max-w-[min(80%,62ch)] rounded-[16px_16px_4px_16px] border border-[color-mix(in_srgb,var(--color-accent)_28%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_13%,var(--color-surface))] px-3.5 py-2.5 text-[13.5px] leading-[1.55] text-[var(--color-text)] transition-opacity duration-200 ${
            pending ? 'opacity-60' : ''
          }`}
        >
          <MarkdownViewer content={text} />
          {pending && (
            <div className="mt-1 flex items-center justify-end gap-1 text-[10.5px] text-[var(--color-text-dim)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-text-dim)] motion-reduce:animate-none" />
              enviando…
            </div>
          )}
        </div>
      </div>
    )
  }
  // Resposta do agente: texto corrido sem moldura, na medida de leitura. É o
  // conteúdo principal da tela, então ganha o maior corpo e a cor plena; o que
  // separa da telemetria ao redor é tipografia e respiro, não uma faixa lateral.
  // Interrompido fecha com um rodapé explícito — sem isso, uma resposta cortada
  // parece uma resposta que simplesmente terminou curta.
  return (
    <div className="chat-prose max-w-[70ch] text-[14.5px] leading-[1.65] text-[var(--color-text)]">
      <MarkdownViewer content={text} />
      {interrupted && (
        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--color-warning)]">
          <Icon as={OctagonX} size={12} />
          Interrompido — a resposta parou aqui.
        </div>
      )}
    </div>
  )
}
