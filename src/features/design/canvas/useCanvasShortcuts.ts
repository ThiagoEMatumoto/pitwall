// Keyboard shortcuts of the design canvas. One window listener in capture
// phase: AppShell's capture-phase globals (Cmd+K, Cmd+Shift+A, Cmd+N,
// Cmd+J, Cmd+B) are registered earlier, run first and are respected
// through defaultPrevented.
// Inactive while a text edit is open, outside edit mode, or when the key
// targets an input/textarea/contenteditable. Space-hold pan lives in
// CanvasStage.

import { useEffect } from 'react'
import { getBridge, useDesignStore, type DesignState } from '@/store/designStore'
import type { ArtboardBridge } from './runtime-bridge'
import type { KeyMessage } from '@shared/design/protocol'
import { copySelection, cutSelection, pasteFromEvent } from './clipboard'
import { isTypingTarget, resolveShortcut, type ShortcutAction } from './shortcuts-map'
import {
  alignSelection,
  changeScope,
  deleteSelection,
  duplicateSelection,
  editSelectedText,
  groupSelection,
  nudgeSelection,
  reorderSelection,
  selectSiblings,
  toggleAutoLayout,
  ungroupSelection,
  zoom,
} from './shortcut-actions'

// ShortcutsPanel listens for this; keeps the panel self-contained.
export const SHORTCUTS_PANEL_TOGGLE_EVENT = 'design:shortcuts-panel-toggle'

function shortcutsActive(state: DesignState): boolean {
  return state.docId !== null && state.mode === 'edit' && state.textEditing === null
}

export function runShortcut(action: ShortcutAction, state: DesignState): void {
  switch (action.type) {
    case 'tool':
      state.setTool(action.tool)
      return
    case 'undo': {
      const id = state.selection.artboardId ?? state.hover?.artboardId
      if (id) state.undo(id)
      return
    }
    case 'redo': {
      const id = state.selection.artboardId ?? state.hover?.artboardId
      if (id) state.redo(id)
      return
    }
    case 'delete':
      deleteSelection(state)
      return
    case 'duplicate':
      duplicateSelection(state)
      return
    case 'group':
      void groupSelection(state)
      return
    case 'ungroup':
      ungroupSelection(state)
      return
    case 'autolayout':
      toggleAutoLayout(state)
      return
    case 'zorder':
      reorderSelection(state, action.dir)
      return
    case 'align':
      void alignSelection(state, action.mode)
      return
    case 'nudge':
      void nudgeSelection(state, action.dx, action.dy)
      return
    case 'zoom':
      zoom(state, action.to)
      return
    case 'scope':
      changeScope(state, action.dir)
      return
    case 'selectAll':
      selectSiblings(state)
      return
    case 'copy':
      copySelection(state)
      return
    case 'cut':
      cutSelection(state)
      return
    case 'paste':
      // The native 'paste' event carries the data (files/text); nothing to do here.
      return
    case 'textCommit':
      editSelectedText(state)
      return
    case 'shortcutsPanel':
      window.dispatchEvent(new CustomEvent(SHORTCUTS_PANEL_TOGGLE_EVENT))
  }
}

// Keys the iframe forwards (focus stays inside the artboard after a text
// edit): only Escape and Cmd+Enter, per the runtime.
function onForwardedKey(msg: KeyMessage): void {
  const state = useDesignStore.getState()
  if (!shortcutsActive(state)) return
  if (msg.key === 'Escape') changeScope(state, 'exit')
  else if (msg.key === 'Enter' && msg.mod) editSelectedText(state)
}

export function useCanvasShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return
      const state = useDesignStore.getState()
      if (!shortcutsActive(state)) return
      const action = resolveShortcut(e)
      if (!action || action.type === 'paste') return
      // Held keys only repeat for nudging.
      if (e.repeat && action.type !== 'nudge') return
      e.preventDefault()
      runShortcut(action, state)
    }

    const onPaste = (e: ClipboardEvent): void => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return
      const state = useDesignStore.getState()
      if (!shortcutsActive(state)) return
      e.preventDefault()
      void pasteFromEvent(state, e.clipboardData).catch((err: unknown) => {
        useDesignStore.setState({
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }

    // Capture: AppShell's workspace handler (bubble, registered earlier) owns
    // Cmd+0/1/±/digits for terminal zoom and pane focus; with a design doc
    // open those keys belong to the canvas. The capture-phase globals of
    // AppShell still run first and are respected via defaultPrevented.
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('paste', onPaste)
    }
  }, [])

  // Bridges register from ArtboardFrame after mount; every store change is a
  // chance to attach to the ones we have not seen yet.
  useEffect(() => {
    const seen = new WeakSet<ArtboardBridge>()
    const offs: Array<() => void> = []
    const attach = (state: DesignState): void => {
      for (const id of Object.keys(state.artboards)) {
        const bridge = getBridge(id)
        if (!bridge || seen.has(bridge)) continue
        seen.add(bridge)
        offs.push(bridge.on('key', onForwardedKey))
      }
    }
    attach(useDesignStore.getState())
    const unsubscribe = useDesignStore.subscribe(attach)
    return () => {
      unsubscribe()
      for (const off of offs) off()
    }
  }, [])
}
