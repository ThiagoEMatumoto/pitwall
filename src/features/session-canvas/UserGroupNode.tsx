import { memo, useEffect, useRef, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { MapNode, UserGroupData } from './graph-to-flow'
import { useMapActions } from './map-context'

// Grupo do usuário ("Frente pagamentos"): arrastar uma sessão pra dentro grava
// sessions.group_id; pra fora, solta. Duplo clique no nome renomeia.
function GroupName({ id, name }: { id: string; name: string }) {
  const actions = useMapActions()
  const editing = actions.renamingGroupId === id
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    setDraft(name)
    requestAnimationFrame(() => inputRef.current?.select())
  }, [editing, name])

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        aria-label="Nome do grupo"
        maxLength={80}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && draft.trim()) actions.renameGroup(id, draft.trim())
          if (e.key === 'Escape') actions.cancelEdit()
        }}
        onBlur={() => (draft.trim() ? actions.renameGroup(id, draft.trim()) : actions.cancelEdit())}
        className="nodrag w-48 rounded border border-[var(--color-accent)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[13px] text-[var(--color-text)] outline-none"
      />
    )
  }
  return (
    <span
      onDoubleClick={(e) => {
        e.stopPropagation()
        actions.startRenameGroup(id)
      }}
      className="cursor-text truncate"
      title="Duplo clique para renomear"
    >
      {name}
    </span>
  )
}

function UserGroupNodeImpl({ data, selected }: NodeProps<MapNode>) {
  const { group, memberCount } = data as UserGroupData
  const actions = useMapActions()
  const color = group.color ?? 'var(--color-violet)'
  return (
    <div
      data-testid="user-group"
      data-group-id={group.id}
      onContextMenu={(e) => actions.openContextMenu(e, `g:${group.id}`)}
      className="h-full w-full rounded-xl border-2"
      style={{
        borderColor: `color-mix(in srgb, ${color} ${selected ? 80 : 45}%, transparent)`,
        borderStyle: selected ? 'dashed' : 'solid',
        background: `color-mix(in srgb, ${color} 7%, transparent)`,
      }}
    >
      <div className="flex items-center gap-1.5 px-3 pt-1.5 text-[13px] font-semibold text-[var(--color-text)]">
        <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: color }} />
        <GroupName id={group.id} name={group.name} />
        <span className="text-[11px] font-normal text-[var(--color-text-dim)]">{memberCount}</span>
      </div>
      {memberCount === 0 && (
        <div className="px-3 pt-3 text-[11px] text-[var(--color-text-dim)]">
          Arraste sessões para cá.
        </div>
      )}
    </div>
  )
}

export const UserGroupNode = memo(UserGroupNodeImpl)
