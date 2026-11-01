import { useState } from 'react'
import { DIAGRAM_TEMPLATES, type DiagramTemplate } from '../../../shared/diagram-templates'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { KIND_LABEL } from './diagram-labels'

interface Props {
  open: boolean
  onClose: () => void
  onPick: (templateId: string) => Promise<void>
}

export function TemplatePickerDialog({ open, onClose, onPick }: Props) {
  const [creating, setCreating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pick = async (template: DiagramTemplate) => {
    setCreating(template.id)
    setError(null)
    try {
      await onPick(template.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(null)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Novo a partir de modelo" widthClassName="w-[36rem]">
      <p className="mb-4 text-[13px] text-[var(--color-text-dim)]">
        Um ponto de partida já organizado em camadas. Depois é só renomear e ajustar no canvas — ou
        pedir ao Claude para adaptar ao seu sistema.
      </p>
      {error && (
        <p role="alert" className="mb-3 text-sm text-[var(--color-danger)]">
          Não deu para criar o diagrama: {error}
        </p>
      )}
      <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
        {DIAGRAM_TEMPLATES.map((template) => (
          <li
            key={template.id}
            className="flex items-center gap-3 px-3 py-2.5"
            data-testid={`template-${template.id}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-text)]">
                {template.name}
                <span className="rounded-full bg-[var(--color-surface-2)] px-1.5 py-px text-[11px] font-normal text-[var(--color-text-dim)]">
                  {KIND_LABEL[template.kind]}
                </span>
              </div>
              <div className="text-xs text-[var(--color-text-dim)]">{template.description}</div>
            </div>
            <Button
              variant="ghost"
              className="shrink-0 px-3 py-1 text-xs"
              loading={creating === template.id}
              disabled={creating !== null}
              onClick={() => void pick(template)}
              aria-label={`Usar modelo ${template.name}`}
            >
              Usar
            </Button>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}
