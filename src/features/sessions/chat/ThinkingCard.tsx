import { useState } from 'react'
import { Brain } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { MarkdownViewer } from '@/components/ui/MarkdownViewer'
import { Chevron, ROW_BUTTON } from './chat-row-ui'
import { oneLine } from './tool-view'

interface Props {
  text: string
}

// Bloco de raciocínio (extended thinking). Colapsado por padrão — é longo e
// secundário à conversa; a primeira frase fica visível pra dizer do que se trata.
export function ThinkingCard({ text }: Props) {
  const [open, setOpen] = useState(false)
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
