import { memo, useEffect, useRef, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { BookmarkPlus } from 'lucide-react'
import { MarkdownViewer } from '@/components/ui/MarkdownViewer'
import { Icon } from '@/components/ui/Icon'
import { FeaturePicker } from '@/features/features/FeaturePicker'
import type { FeatureWithActivity } from '@/features/features/feature-activity'
import { showToast } from '@/features/notifications/toast-store'
import { canvasApi, featuresApi } from '@/lib/ipc'
import type { MapNode, NoteData } from './graph-to-flow'
import { useMapActions } from './map-context'

// Post-it em markdown. Duplo clique edita; Ctrl+Enter ou sair do campo salva,
// Esc descarta. O foco vai direto pro texto ao criar (no Maestri o que se
// digitava depois de criar a nota caía no terminal).
function NoteNodeImpl({ data, selected }: NodeProps<MapNode>) {
  const { note, sessionEnded } = data as NoteData
  const actions = useMapActions()
  const editing = actions.editingNoteId === note.id
  const [draft, setDraft] = useState(note.bodyMd)
  const ref = useRef<HTMLTextAreaElement>(null)
  const color = note.color ?? 'var(--color-warning)'

  useEffect(() => {
    if (!editing) return
    setDraft(note.bodyMd)
    requestAnimationFrame(() => ref.current?.focus())
  }, [editing, note.bodyMd])

  return (
    <div
      data-testid="canvas-note"
      data-note-id={note.id}
      onContextMenu={(e) => actions.openContextMenu(e, `n:${note.id}`)}
      onDoubleClick={() => actions.startEditNote(note.id)}
      className="flex h-full w-full flex-col overflow-hidden rounded-md border text-[13px] leading-snug shadow-md"
      style={{
        borderColor: selected
          ? 'var(--color-accent)'
          : `color-mix(in srgb, ${color} 45%, transparent)`,
        borderStyle: selected ? 'dashed' : 'solid',
        // Âmbar mais presente que o marrom de antes; texto claro sobre ele passa AA folgado.
        background: `color-mix(in srgb, ${color} 22%, var(--color-surface))`,
      }}
    >
      <Handle
        type="source"
        position={Position.Left}
        className="!h-1 !w-1 !border-0 !bg-transparent"
      />
      <div
        className="flex min-h-2 shrink-0 items-center px-2"
        style={{ background: `color-mix(in srgb, ${color} 45%, transparent)` }}
      >
        {sessionEnded && (
          <span
            data-testid="note-session-ended"
            className="text-[10px] text-[var(--color-text-dim)]"
          >
            sessão encerrada
          </span>
        )}
        {!editing && note.bodyMd.trim() && <FixToFeature noteId={note.id} text={note.bodyMd} />}
      </div>
      {editing ? (
        <textarea
          ref={ref}
          value={draft}
          aria-label="Texto da nota"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) actions.saveNote(note.id, draft)
            if (e.key === 'Escape') actions.cancelEdit()
          }}
          onBlur={() => actions.saveNote(note.id, draft)}
          className="nodrag nowheel min-h-0 flex-1 resize-none bg-transparent px-2 py-1.5 font-mono text-[12px] text-[var(--color-text)] outline-none"
        />
      ) : (
        <div className="nowheel min-h-0 flex-1 overflow-y-auto px-2 py-1.5 text-[var(--color-text)]">
          {note.bodyMd.trim() ? (
            <MarkdownViewer content={note.bodyMd} />
          ) : (
            <span className="italic text-[var(--color-text-dim)]">
              Nota vazia — duplo clique para escrever
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// "Fixar na feature": o texto vai para as notas fixadas da feature escolhida
// (doc .md da feature) e a nota sai do canvas — ela mudou de casa, não duplicou.
function FixToFeature({ noteId, text }: { noteId: string; text: string }) {
  const [open, setOpen] = useState(false)
  const [features, setFeatures] = useState<FeatureWithActivity[]>([])

  function toggle() {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    void featuresApi.listWithStats().then(setFeatures)
  }

  async function pick(featureId: string | null) {
    setOpen(false)
    if (!featureId) return
    let feature: Awaited<ReturnType<typeof featuresApi.appendFixedNote>>
    try {
      feature = await featuresApi.appendFixedNote({ featureId, text })
    } catch {
      showToast({ title: 'Não deu para fixar a nota', body: 'A nota continua no mapa.' })
      return
    }
    // Já está na feature: falhar aqui não pode convidar a tentar de novo (duplicaria).
    try {
      await canvasApi.deleteNote({ id: noteId })
    } catch {
      showToast({
        title: 'Nota fixada, mas continua no mapa',
        body: `Já está em «${feature.title}». Apague a nota do mapa à mão.`,
      })
      return
    }
    showToast({ title: 'Nota fixada na feature', body: `Agora está em «${feature.title}».` })
  }

  return (
    <div className="nodrag relative ml-auto">
      <button
        type="button"
        data-testid="note-fix-to-feature"
        onClick={(e) => {
          e.stopPropagation()
          toggle()
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        title="Fixar na feature"
        aria-label="Fixar na feature"
        className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
      >
        <Icon as={BookmarkPlus} size={11} />
        <span>Fixar na feature</span>
      </button>
      {open && (
        <FeaturePicker
          features={features}
          value={null}
          onPick={(id) => void pick(id)}
          onClose={() => setOpen(false)}
          align="right"
          testId="note-feature-picker"
        />
      )}
    </div>
  )
}

export const NoteNode = memo(NoteNodeImpl)
