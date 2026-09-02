import { useState } from 'react'
import { Mic, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Input'
import { Menu } from '@/components/ui/Menu'
import { activeMarker } from '@/features/brand'
import type { Meeting } from '../../../shared/types/ipc'
import { STATUS_COLOR, STATUS_LABEL, formatDateTime, formatDuration } from './format'

interface Props {
  meetings: Meeting[]
  selectedId: string | null
  activeElapsedMs: number
  loading: boolean
  startDisabled: boolean
  onSelect: (id: string) => void
  onStart: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}

export function MeetingList({
  meetings,
  selectedId,
  activeElapsedMs,
  loading,
  startDisabled,
  onSelect,
  onStart,
  onRename,
  onDelete,
}: Props) {
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<Meeting | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleting, setDeleting] = useState<Meeting | null>(null)

  const openRename = (m: Meeting) => {
    setRenaming(m)
    setRenameValue(m.title)
  }

  const submitRename = () => {
    if (!renaming) return
    const title = renameValue.trim()
    if (title && title !== renaming.title) onRename(renaming.id, title)
    setRenaming(null)
  }

  if (meetings.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center text-sm text-[var(--color-text-dim)]">
        <Icon as={Mic} size={24} />
        <p>{loading ? 'Carregando…' : 'Nenhuma reunião ainda'}</p>
        {!loading && (
          <Button onClick={onStart} disabled={startDisabled} className="!px-3 !py-1 !text-xs">
            Iniciar gravação
          </Button>
        )}
      </div>
    )
  }

  return (
    <>
      <ul className="flex-1 overflow-y-auto">
        {meetings.map((m) => {
          const active = m.id === selectedId
          const recording = m.status === 'recording'
          return (
            <li
              key={m.id}
              className={`group relative border-b border-[var(--color-border)] transition ${
                active ? `bg-[var(--color-surface-2)] ${activeMarker}` : 'hover:bg-[var(--color-surface-2)]/60'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(m.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenuFor(m.id)
                }}
                className="flex w-full flex-col gap-1 px-4 py-3 pr-9 text-left"
              >
                <span className="truncate text-sm font-medium text-[var(--color-text)]">{m.title}</span>
                <span className="flex items-center gap-2 text-[11px] text-[var(--color-text-dim)]">
                  <span>{formatDateTime(m.startedAt)}</span>
                  <span className="tabular-nums">
                    {formatDuration(recording ? activeElapsedMs : m.durationMs)}
                  </span>
                  <span
                    className="rounded-full border px-1.5 py-px"
                    style={{
                      color: STATUS_COLOR[m.status],
                      borderColor: `color-mix(in srgb, ${STATUS_COLOR[m.status]} 45%, transparent)`,
                    }}
                  >
                    {STATUS_LABEL[m.status]}
                  </span>
                </span>
              </button>
              <div className="absolute right-2 top-2.5">
                <Menu
                  open={menuFor === m.id}
                  onClose={() => setMenuFor(null)}
                  items={[
                    { label: 'Renomear', onClick: () => openRename(m) },
                    { label: 'Excluir', danger: true, onClick: () => setDeleting(m) },
                  ]}
                >
                  <button
                    type="button"
                    onClick={() => setMenuFor(menuFor === m.id ? null : m.id)}
                    title="Mais ações"
                    className={`flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-dim)] transition hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] ${
                      menuFor === m.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <Icon as={MoreHorizontal} />
                  </button>
                </Menu>
              </div>
            </li>
          )
        })}
      </ul>

      <Dialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Renomear reunião"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancelar
            </Button>
            <Button onClick={submitRename} disabled={!renameValue.trim()}>
              Salvar
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submitRename()
          }}
        >
          <Input label="Título" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
        </form>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Excluir reunião"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleting) onDelete(deleting.id)
                setDeleting(null)
              }}
            >
              Excluir
            </Button>
          </>
        }
      >
        <p className="text-sm text-[var(--color-text)]">
          Excluir <strong>{deleting?.title}</strong>? Transcrição, notas e resumo somem junto. Tarefas já criadas
          ficam.
        </p>
      </Dialog>
    </>
  )
}
