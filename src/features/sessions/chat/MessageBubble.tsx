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
  const isUser = role === 'user'
  if (isUser) {
    // Bolha do usuário: alinhada à direita, gradiente da marca translúcido,
    // cauda inferior-direita (radius 16 16 4 16).
    return (
      <div className="flex justify-end">
        <div
          className={`max-w-[80%] rounded-[16px_16px_4px_16px] border border-[color-mix(in_srgb,var(--color-accent)_32%,transparent)] px-3.5 py-2.5 text-[13.5px] leading-[1.5] text-[var(--color-text)] ${
            pending ? 'opacity-60' : ''
          }`}
          style={{
            background:
              'linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 15%, transparent), color-mix(in srgb, var(--color-accent2) 6%, transparent))',
          }}
        >
          <MarkdownViewer content={text} />
          {pending && (
            <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-[var(--color-text-dim)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-text-dim)]" />
              enviando…
            </div>
          )}
        </div>
      </div>
    )
  }
  // Bloco do agente: corpo em Schibsted, sem bolha, marcado por uma borda-esquerda
  // accent (linguagem "em pista"). Interrompido troca a borda pro tom de aviso e
  // fecha com um rodapé explícito — sem isso, uma resposta cortada no meio parece
  // uma resposta que simplesmente terminou curta.
  return (
    <div
      className={`border-l-2 pl-3.5 text-[14px] leading-[1.55] text-[var(--color-text)] ${
        interrupted
          ? 'border-[var(--color-warning,var(--color-accent))]'
          : 'border-[var(--color-accent)]'
      }`}
    >
      <MarkdownViewer content={text} />
      {interrupted && (
        <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--color-warning,var(--color-accent))]">
          <Icon as={OctagonX} size={11} />
          Interrompido — a resposta parou aqui.
        </div>
      )}
    </div>
  )
}
