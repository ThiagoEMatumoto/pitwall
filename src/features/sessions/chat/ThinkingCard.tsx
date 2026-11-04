import { useState } from 'react'
import { Brain } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { MarkdownViewer } from '@/components/ui/MarkdownViewer'
import { Chevron, ROW_BUTTON } from './chat-row-ui'
import { oneLine } from './tool-view'

interface Props {
  text: string
}

// O TUI mostra o raciocínio resumido inline; colapsar esse texto curto faria o
// chat perder o que o terminal mostra. Só o raciocínio longo nasce colapsado,
// com a primeira frase visível pra dizer do que se trata.
const OPEN_BY_DEFAULT_MAX_CHARS = 600

// Bloco de raciocínio (extended thinking).
export function ThinkingCard({ text }: Props) {
  const [open, setOpen] = useState(() => text.length <= OPEN_BY_DEFAULT_MAX_CHARS)
  const preview = oneLine(text, 120)
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={ROW_BUTTON}
      >
        <Chevron open={open} />
        <Icon as={Brain} size={13} className="shrink-0 text-[var(--color-text-dim)]" />
        <span className="shrink-0 font-medium text-[var(--color-text-dim)]">Raciocínio</span>
        {!open && preview && (
          <span className="min-w-0 truncate italic text-[var(--color-text-dim)]/80">{preview}</span>
        )}
      </button>
      {open && (
        <div className="chat-reveal mb-2 ml-6 mt-1 max-w-[68ch] text-[13px] italic leading-relaxed text-[var(--color-text-dim)]">
          <MarkdownViewer content={text} />
        </div>
      )}
    </div>
  )
}
