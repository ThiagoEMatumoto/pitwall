import { createContext, useContext } from 'react'
import type { SessionGraphNode } from '../../../shared/types/session-graph'

// Ações do mapa que os nós disparam. Contexto em vez de callbacks no `data` do
// nó: o data vira parte do diff do xyflow a cada push do grafo, e funções novas
// a cada render invalidariam todos os nós.
export interface MapActions {
  editingPurposeId: string | null
  startEditPurpose: (sessionId: string) => void
  savePurpose: (sessionId: string, purpose: string | null) => void
  cancelEdit: () => void
  summarizingIds: ReadonlySet<string>
  summarize: (sessionId: string) => void
  editingNoteId: string | null
  startEditNote: (noteId: string) => void
  saveNote: (noteId: string, body: string) => void
  renamingGroupId: string | null
  startRenameGroup: (groupId: string) => void
  renameGroup: (groupId: string, name: string) => void
  openContextMenu: (e: React.MouseEvent, flowId: string) => void
  peek: (node: SessionGraphNode) => void
  // "+ Nova sessão" da lane de repo (e duplo clique na área vazia dela).
  newSession: (repoId: string | null) => void
  // "N filhas ▾": abre/recolhe o leque de fios de uma mãe com muitas filhas.
  toggleFan: (sessionId: string) => void
  // Cartão vivo: recolhido ⇄ aberto, e o terminal real na modal do mapa.
  toggleView: (sessionId: string) => void
  interact: (sessionId: string) => void
  // Pan animado até o cartão de outra sessão (chip "↳ de <mãe>").
  centerOn: (sessionId: string) => void
  // Ações rápidas do cartão da mãe (MotherCard): as mesmas do menu do cartão.
  passBaton: (node: SessionGraphNode) => void
  newChild: (node: SessionGraphNode) => void
  // Espiar filhas: a modal do mapa na 1ª filha, com a faixa de troca só entre elas.
  peekChildren: (motherId: string) => void
}

export const MapActionsContext = createContext<MapActions | null>(null)

export function useMapActions(): MapActions {
  const ctx = useContext(MapActionsContext)
  if (!ctx) throw new Error('useMapActions fora do SessionMap')
  return ctx
}
