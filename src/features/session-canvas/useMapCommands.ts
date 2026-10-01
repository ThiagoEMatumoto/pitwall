import { useCallback, useMemo, useRef, useState } from 'react'
import { canvasApi } from '@/lib/ipc'
import { showToast } from '@/features/notifications/toast-store'
import { useCrewDockStore, type CrewPeekMode } from '@/features/handoffs/crew-dock-store'
import { dockCrew } from '@/features/handoffs/crew'
import { openMapPeek } from '@/features/handoffs/open-map-peek'
import { useAppStore } from '@/store/appStore'
import { useHandoffsStore } from '@/store/handoffsStore'
import type { SessionGraphNode } from '../../../shared/types/session-graph'
import type { CanvasScope, SessionGroup } from '../../../shared/types/canvas'
import { useCanvasStateStore } from './canvas-state-store'
import { useProjectsViewStore } from './projects-view-store'
import { tidyPositions } from './tidy'
import { liftGroup, terminalHostFor } from './card-view'
import type { MapInput } from './graph-to-flow'
import type { DelegateTarget } from './DelegateDialog'

export interface BatonTarget {
  sessionId: string
  ccSessionId: string
  repoLabel: string | undefined
}

// Fluxo de nova sessão aberto do mapa. repoId null = escolher o repo na lista.
export interface NewSessionRequest {
  repoId: string | null
}

// Bastão só pra quem tem transcript a destilar (mesma regra do header do pane).
export function canPassBaton(n: SessionGraphNode): boolean {
  return n.provider === 'claude' && !!n.ccSessionId && n.status !== 'ended'
}

function fail(title: string) {
  return (err: unknown) =>
    showToast({ title, body: err instanceof Error ? err.message : String(err) })
}

// Tudo que o mapa manda pro main + a navegação (peek/aba). Os estados de edição
// moram aqui porque os comandos os abrem e fecham.
export function useMapCommands(scope: CanvasScope, input: () => MapInput) {
  const [editingPurposeId, setEditingPurposeId] = useState<string | null>(null)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const [summarizingIds, setSummarizingIds] = useState<ReadonlySet<string>>(new Set())
  const [newSession, setNewSession] = useState<NewSessionRequest | null>(null)
  const [delegateTarget, setDelegateTarget] = useState<DelegateTarget | null>(null)
  const [batonTarget, setBatonTarget] = useState<BatonTarget | null>(null)
  // Enter e blur salvam os dois; o ref garante um save só por edição.
  const editingRef = useRef<string | null>(null)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelPendingClick = useCallback(() => {
    if (clickTimer.current) clearTimeout(clickTimer.current)
    clickTimer.current = null
  }, [])

  const cancelEdit = useCallback(() => {
    editingRef.current = null
    setEditingPurposeId(null)
    setEditingNoteId(null)
    setRenamingGroupId(null)
  }, [])

  const startEdit = useCallback(
    (key: string, set: (id: string) => void, id: string) => {
      cancelPendingClick()
      cancelEdit()
      editingRef.current = key
      set(id)
    },
    [cancelPendingClick, cancelEdit],
  )

  const takeEdit = (key: string): boolean => {
    if (editingRef.current !== key) return false
    cancelEdit()
    return true
  }

  // A modal do mapa (lift): nenhuma destas navega — a vista segue 'map' e a
  // câmera fica onde está. A faixa de troca leva as irmãs do mesmo agrupamento.
  const openLift = useCallback(
    (sessionId: string, mode: CrewPeekMode) => {
      const { graph, inUse } = input()
      openMapPeek(sessionId, mode, liftGroup(graph.nodes, sessionId, inUse ?? new Set([sessionId])))
    },
    // input lê um ref: estável o bastante pra memoizar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Espiar: a conversa (ou o terminal, sem Chat View) na modal. Filha do dock
  // abre o peek do handoff (openMapPeek) mesmo sem PTY viva: a pergunta pendente
  // e a resposta pelo canal do handoff não dependem dela.
  const peek = useCallback(
    (node: SessionGraphNode) => {
      const mode = node.provider === 'claude' ? 'chat' : 'terminal'
      const isLive = useAppStore.getState().liveSessions.some((s) => s.id === node.sessionId)
      const inDock = dockCrew(useHandoffsStore.getState().handoffs).some(
        (h) => h.childSessionId === node.sessionId,
      )
      if (!isLive && !inDock) return
      openLift(node.sessionId, mode)
    },
    [openLift],
  )

  // "Abrir na aba": a ÚNICA ação do mapa que navega.
  const openTab = useCallback((node: SessionGraphNode) => {
    const { liveSessions, focusOrOpenSession } = useAppStore.getState()
    const live = liveSessions.find((s) => s.id === node.sessionId)
    if (!live) return
    const dock = useCrewDockStore.getState()
    if (dock.peekTarget) dock.closePeek({ restoreFocus: false })
    useProjectsViewStore.getState().setView('terminals')
    void focusOrOpenSession(live)
  }, [])

  // "Terminal" (botão, Enter, duplo clique): o terminal real na modal, em 14px,
  // sobre o mapa. Com aba aberta a modal assume a PTY (terminal-lease).
  const interact = useCallback(
    (sessionId: string) => {
      cancelPendingClick()
      const live = useAppStore.getState().liveSessions.find((s) => s.id === sessionId)
      if (terminalHostFor(live) === 'none') {
        showToast({ title: 'Sem terminal vivo', body: 'Esta sessão não tem PTY aberta no app.' })
        return
      }
      openLift(sessionId, 'terminal')
    },
    [cancelPendingClick, openLift],
  )

  // Clique abre o peek; duplo clique abre o terminal na modal. O clique espera o
  // intervalo do duplo, senão o peek cobriria o mapa antes do 2º clique chegar.
  const clickCard = useCallback(
    (node: SessionGraphNode) => {
      cancelPendingClick()
      clickTimer.current = setTimeout(() => peek(node), 250)
    },
    [cancelPendingClick, peek],
  )
  const doubleClickCard = useCallback(
    (node: SessionGraphNode) => {
      cancelPendingClick()
      interact(node.sessionId)
    },
    [cancelPendingClick, interact],
  )

  const savePurpose = (sessionId: string, purpose: string | null) => {
    if (!takeEdit(`purpose:${sessionId}`)) return
    canvasApi.setPurpose({ sessionId, purpose }).catch(fail('Não foi possível salvar o propósito'))
  }

  const summarizeOne = (sessionId: string): Promise<void> => {
    setSummarizingIds((prev) => new Set([...prev, sessionId]))
    return canvasApi
      .summarize({ sessionId })
      .then((r) => {
        if (!r.ok) showToast({ title: 'Não foi possível resumir', body: r.error })
      })
      .catch(fail('Não foi possível resumir'))
      .finally(() =>
        setSummarizingIds((prev) => new Set([...prev].filter((id) => id !== sessionId))),
      )
      .then(() => undefined)
  }
  const summarize = (sessionId: string) => void summarizeOne(sessionId)

  const createNote = (attachedSessionId: string | null) => {
    canvasApi
      .createNote({ scope, bodyMd: '', attachedSessionId })
      .then((note) => startEdit(`note:${note.id}`, setEditingNoteId, note.id))
      .catch(fail('Não foi possível criar a nota'))
  }

  const saveNote = (noteId: string, body: string) => {
    if (!takeEdit(`note:${noteId}`)) return
    canvasApi.updateNote({ id: noteId, bodyMd: body }).catch(fail('Não foi possível salvar a nota'))
  }

  const setNoteAttachment = (noteId: string, sessionId: string | null) => {
    canvasApi
      .updateNote({ id: noteId, attachedSessionId: sessionId })
      .catch(fail('Não foi possível mover a nota'))
  }

  const deleteNote = (noteId: string) => {
    canvasApi.deleteNote({ id: noteId }).catch(fail('Não foi possível apagar a nota'))
  }

  const createGroup = () => {
    canvasApi
      .createGroup({ scope, name: 'Novo grupo' })
      .then((g) => startEdit(`group:${g.id}`, setRenamingGroupId, g.id))
      .catch(fail('Não foi possível criar o grupo'))
  }

  const renameGroup = (groupId: string, name: string) => {
    if (!takeEdit(`group:${groupId}`)) return
    canvasApi.updateGroup({ id: groupId, name }).catch(fail('Não foi possível renomear o grupo'))
  }

  const recolorGroup = (group: SessionGroup, color: string | null) => {
    canvasApi.updateGroup({ id: group.id, color }).catch(fail('Não foi possível mudar a cor'))
  }

  const deleteGroup = (groupId: string) => {
    canvasApi.deleteGroup({ id: groupId }).catch(fail('Não foi possível apagar o grupo'))
  }

  // Pelo menu (sem arrastar): a posição relativa antiga não vale no pai novo, então
  // a sessão entra no fim da coluna do grupo.
  const moveToGroup = async (sessionId: string, groupId: string | null, slotY?: number) => {
    const save = useCanvasStateStore.getState().savePositions
    try {
      if (slotY !== undefined) {
        await save(scope, [{ kind: 'session', entityId: sessionId, x: 12, y: slotY }])
      }
      await canvasApi.setSessionGroup({ sessionId, groupId })
    } catch (err) {
      fail('Não foi possível mover a sessão')(err)
    }
  }

  const tidy = async () => {
    try {
      const items = tidyPositions(input())
      await canvasApi.clearPositions({ scope })
      await useCanvasStateStore.getState().savePositions(scope, items)
    } catch (err) {
      fail('Não foi possível organizar o mapa')(err)
    }
  }

  const openNewSession = (repoId: string | null) => {
    cancelPendingClick()
    setNewSession({ repoId })
  }
  const closeNewSession = () => setNewSession(null)

  const newChildOf = (n: SessionGraphNode) => {
    cancelPendingClick()
    setDelegateTarget({
      motherSessionId: n.sessionId,
      motherTitle: n.title,
      targetRepoId: n.repoId,
      targetRepoLabel: n.repoLabel,
      pickRepo: true,
    })
  }
  const delegateTo = (target: DelegateTarget) => setDelegateTarget(target)
  const closeDelegate = () => setDelegateTarget(null)

  const passBatonOf = (n: SessionGraphNode) => {
    if (!canPassBaton(n)) return
    setBatonTarget({
      sessionId: n.sessionId,
      ccSessionId: n.ccSessionId!,
      repoLabel: n.repoLabel ?? undefined,
    })
  }
  const closeBaton = () => setBatonTarget(null)

  const startEditPurpose = (id: string) => startEdit(`purpose:${id}`, setEditingPurposeId, id)
  const startEditNote = (id: string) => startEdit(`note:${id}`, setEditingNoteId, id)
  const startRenameGroup = (id: string) => startEdit(`group:${id}`, setRenamingGroupId, id)

  return useMemo(
    () => ({
      editingPurposeId,
      editingNoteId,
      renamingGroupId,
      summarizingIds,
      cancelEdit,
      startEditPurpose,
      startEditNote,
      startRenameGroup,
      savePurpose,
      summarize,
      createNote,
      saveNote,
      setNoteAttachment,
      deleteNote,
      createGroup,
      renameGroup,
      recolorGroup,
      deleteGroup,
      moveToGroup,
      tidy,
      peek,
      openTab,
      clickCard,
      doubleClickCard,
      interact,
      newSession,
      openNewSession,
      closeNewSession,
      delegateTarget,
      newChildOf,
      delegateTo,
      closeDelegate,
      batonTarget,
      passBatonOf,
      closeBaton,
    }),
    // Os comandos leem estado por getState()/refs; o memo só precisa acompanhar
    // o que os nós exibem.
    [
      editingPurposeId,
      editingNoteId,
      renamingGroupId,
      summarizingIds,
      scope,
      newSession,
      delegateTarget,
      batonTarget,
    ],
  )
}

export type MapCommands = ReturnType<typeof useMapCommands>
