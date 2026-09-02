// Undo/redo stacks, one pair per artboard. Entries carry the forward ops and
// the inverse ops (computed against the tree BEFORE the forward ops ran).
// Consecutive pushes sharing a coalesceKey (e.g. arrow-key nudges of the same
// node) merge into one entry so a single Cmd+Z reverts the whole gesture.

import type { DesignOp } from '@shared/types/design'

export interface UndoEntry {
  ops: DesignOp[]
  inverse: DesignOp[]
  coalesceKey?: string
}

interface Stacks {
  undo: UndoEntry[]
  redo: UndoEntry[]
}

export const UNDO_LIMIT = 200

export class UndoHistory {
  private readonly stacks = new Map<string, Stacks>()

  private stacksFor(artboardId: string): Stacks {
    let s = this.stacks.get(artboardId)
    if (!s) {
      s = { undo: [], redo: [] }
      this.stacks.set(artboardId, s)
    }
    return s
  }

  push(artboardId: string, entry: UndoEntry): void {
    const s = this.stacksFor(artboardId)
    const top = s.undo[s.undo.length - 1]
    if (entry.coalesceKey && top?.coalesceKey === entry.coalesceKey) {
      // Inverses undo in reverse order: the newest inverse must run first.
      s.undo[s.undo.length - 1] = {
        ops: [...top.ops, ...entry.ops],
        inverse: [...entry.inverse, ...top.inverse],
        coalesceKey: entry.coalesceKey,
      }
    } else {
      s.undo.push(entry)
      if (s.undo.length > UNDO_LIMIT) s.undo.shift()
    }
    s.redo = []
  }

  // Ends the current coalescing group: the next push with the same key
  // starts a fresh entry (a second drag must not merge into the first).
  seal(artboardId: string): void {
    const s = this.stacks.get(artboardId)
    const top = s?.undo[s.undo.length - 1]
    if (top?.coalesceKey) s!.undo[s!.undo.length - 1] = { ops: top.ops, inverse: top.inverse }
  }

  // Moves the top undo entry to the redo stack and returns it.
  popUndo(artboardId: string): UndoEntry | null {
    const s = this.stacksFor(artboardId)
    const entry = s.undo.pop()
    if (!entry) return null
    s.redo.push(entry)
    return entry
  }

  popRedo(artboardId: string): UndoEntry | null {
    const s = this.stacksFor(artboardId)
    const entry = s.redo.pop()
    if (!entry) return null
    s.undo.push(entry)
    return entry
  }

  // Drops an entry that could not be applied (its target vanished remotely).
  discard(artboardId: string, entry: UndoEntry): void {
    const s = this.stacksFor(artboardId)
    s.undo = s.undo.filter((e) => e !== entry)
    s.redo = s.redo.filter((e) => e !== entry)
  }

  canUndo(artboardId: string): boolean {
    return (this.stacks.get(artboardId)?.undo.length ?? 0) > 0
  }

  canRedo(artboardId: string): boolean {
    return (this.stacks.get(artboardId)?.redo.length ?? 0) > 0
  }

  clear(artboardId: string): void {
    this.stacks.delete(artboardId)
  }

  clearAll(): void {
    this.stacks.clear()
  }
}
