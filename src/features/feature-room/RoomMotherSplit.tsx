import { useEffect, useState } from 'react'
import type { RoomMotherTab } from './room-model'
import { MotherOverflow, RoomMotherPane } from './RoomMotherPane'

export const MAX_SPLIT = 3

interface Props {
  mothers: RoomMotherTab[]
  // A coluna ativa (selectedMotherId da sala). Pode ser uma recém-criada que o
  // grafo ainda não enxerga: entra no split mesmo fora de `mothers`.
  activeId: string
  onActivate: (sessionId: string) => void
  onPeek: (sessionId: string) => void
}

// Colunas mostradas: as que já estavam (sem pular de lugar), completadas pela
// ordem das mães; a ativa sempre está, no lugar da última se faltar espaço.
function nextColumns(prev: string[], ids: string[], activeId: string): string[] {
  const kept = prev.filter((id) => ids.includes(id))
  const cols = [...kept, ...ids.filter((id) => !kept.includes(id))].slice(0, MAX_SPLIT)
  if (!cols.includes(activeId)) cols[Math.min(cols.length, MAX_SPLIT - 1)] = activeId
  return cols
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

// Sala com 2-3 mães lado a lado. Um terminal por vez: pedir o Terminal numa coluna
// devolve a outra ao chat (só ela ocupa slot WebGL; a lease 'room' é por sessão).
export function RoomMotherSplit({ mothers, activeId, onActivate, onPeek }: Props) {
  const ids = mothers.map((m) => m.sessionId)
  if (!ids.includes(activeId)) ids.push(activeId)
  const [columns, setColumns] = useState<string[]>(() => nextColumns([], ids, activeId))
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const want = nextColumns(columns, ids, activeId)
  const idsKey = ids.join(',')

  useEffect(() => {
    setColumns((cur) => {
      const next = nextColumns(cur, idsKey.split(','), activeId)
      return same(cur, next) ? cur : next
    })
  }, [idsKey, activeId])
  useEffect(() => {
    if (terminalId && !want.includes(terminalId)) setTerminalId(null)
  }, [terminalId, want])

  // Ctrl+. alterna Chat⇄Terminal da coluna ATIVA. Captura: com o foco no xterm a
  // tecla não chega à bolha do React.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.key !== '.') return
      if (document.querySelector('[data-modal-overlay], [aria-modal="true"]')) return
      e.preventDefault()
      e.stopPropagation()
      if (!e.repeat) setTerminalId((t) => (t === activeId ? null : activeId))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [activeId])

  const shown = want
  const overflow = mothers.filter((m) => !shown.includes(m.sessionId))
  const swap = (id: string) => {
    setColumns((cur) => {
      const cols = nextColumns(cur, ids, activeId)
      const at = cols.indexOf(activeId)
      return cols.map((c, i) => (i === at ? id : c))
    })
    onActivate(id)
  }

  return (
    <div
      data-testid="room-mother-split"
      data-columns={shown.length}
      className="flex min-h-0 flex-1"
    >
      <div
        className="grid min-h-0 min-w-0 flex-1 max-[900px]:!grid-cols-1 max-[900px]:overflow-auto"
        style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}
      >
        {shown.map((id) => (
          <div
            key={id}
            className="flex min-h-0 min-w-0 flex-col border-r border-[var(--color-border)] last:border-r-0 max-[900px]:min-h-[480px] max-[900px]:border-r-0 max-[900px]:border-b"
          >
            <RoomMotherPane
              mothers={mothers}
              motherId={id}
              mode={terminalId === id ? 'terminal' : 'chat'}
              active={id === activeId}
              onToggleMode={() => setTerminalId((t) => (t === id ? null : id))}
              onFocus={onActivate}
              onPeek={onPeek}
            />
          </div>
        ))}
      </div>
      {overflow.length > 0 && <MotherOverflow mothers={overflow} onSwap={swap} />}
    </div>
  )
}
