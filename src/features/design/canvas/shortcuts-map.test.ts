import { describe, expect, it } from 'vitest'
import { formatCombo, matchCombo, COMMANDS } from '@/lib/keybindings'
import { SHORTCUTS, resolveShortcut, type KeyFacts } from './shortcuts-map'

const key = (
  k: string,
  mods: Partial<Pick<KeyFacts, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {},
  code = '',
): KeyFacts => ({
  key: k,
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('resolveShortcut', () => {
  it('single letters pick tools', () => {
    expect(resolveShortcut(key('v'))).toEqual({ type: 'tool', tool: 'move' })
    expect(resolveShortcut(key('F'))).toEqual({ type: 'tool', tool: 'frame' })
    expect(resolveShortcut(key('r'))).toEqual({ type: 'tool', tool: 'rect' })
    expect(resolveShortcut(key('o'))).toEqual({
      type: 'tool',
      tool: 'ellipse',
    })
    expect(resolveShortcut(key('t'))).toEqual({ type: 'tool', tool: 'text' })
    expect(resolveShortcut(key('h'))).toEqual({ type: 'tool', tool: 'hand' })
  })

  it('undo/redo on Ctrl and on Cmd', () => {
    expect(resolveShortcut(key('z', { ctrlKey: true }))).toEqual({
      type: 'undo',
    })
    expect(resolveShortcut(key('z', { metaKey: true }))).toEqual({
      type: 'undo',
    })
    expect(resolveShortcut(key('Z', { metaKey: true, shiftKey: true }))).toEqual({ type: 'redo' })
  })

  it('delete has a Backspace alias', () => {
    expect(resolveShortcut(key('Delete'))).toEqual({ type: 'delete' })
    expect(resolveShortcut(key('Backspace'))).toEqual({ type: 'delete' })
  })

  it('edit combos', () => {
    expect(resolveShortcut(key('d', { metaKey: true }))).toEqual({
      type: 'duplicate',
    })
    expect(resolveShortcut(key('c', { ctrlKey: true }))).toEqual({
      type: 'copy',
    })
    expect(resolveShortcut(key('x', { ctrlKey: true }))).toEqual({
      type: 'cut',
    })
    expect(resolveShortcut(key('v', { ctrlKey: true }))).toEqual({
      type: 'paste',
    })
    expect(resolveShortcut(key('a', { ctrlKey: true }))).toEqual({
      type: 'selectAll',
    })
    expect(resolveShortcut(key('Enter', { metaKey: true }))).toEqual({
      type: 'textCommit',
    })
  })

  it('group / ungroup / auto-layout', () => {
    expect(resolveShortcut(key('g', { metaKey: true }))).toEqual({
      type: 'group',
    })
    expect(resolveShortcut(key('G', { metaKey: true, shiftKey: true }))).toEqual({
      type: 'ungroup',
    })
    expect(resolveShortcut(key('A', { shiftKey: true }))).toEqual({
      type: 'autolayout',
    })
  })

  it('z-order matches by physical bracket keys; Alt goes to the ends', () => {
    expect(resolveShortcut(key(']', { metaKey: true }, 'BracketRight'))).toEqual({
      type: 'zorder',
      dir: 'up',
    })
    expect(resolveShortcut(key('[', { metaKey: true }, 'BracketLeft'))).toEqual({
      type: 'zorder',
      dir: 'down',
    })
    expect(resolveShortcut(key('‘', { metaKey: true, altKey: true }, 'BracketRight'))).toEqual({
      type: 'zorder',
      dir: 'top',
    })
    expect(resolveShortcut(key('“', { metaKey: true, altKey: true }, 'BracketLeft'))).toEqual({
      type: 'zorder',
      dir: 'bottom',
    })
  })

  it('Alt+letter aligns by code even when key is a dead/odd character', () => {
    expect(resolveShortcut(key('å', { altKey: true }, 'KeyA'))).toEqual({
      type: 'align',
      mode: 'left',
    })
    expect(resolveShortcut(key('d', { altKey: true }, 'KeyD'))).toEqual({
      type: 'align',
      mode: 'right',
    })
    expect(resolveShortcut(key('w', { altKey: true }, 'KeyW'))).toEqual({
      type: 'align',
      mode: 'top',
    })
    expect(resolveShortcut(key('s', { altKey: true }, 'KeyS'))).toEqual({
      type: 'align',
      mode: 'bottom',
    })
    expect(resolveShortcut(key('h', { altKey: true }, 'KeyH'))).toEqual({
      type: 'align',
      mode: 'centerH',
    })
    expect(resolveShortcut(key('v', { altKey: true }, 'KeyV'))).toEqual({
      type: 'align',
      mode: 'centerV',
    })
  })

  it('arrows nudge 1px, Shift makes it 10px', () => {
    expect(resolveShortcut(key('ArrowLeft'))).toEqual({
      type: 'nudge',
      dx: -1,
      dy: 0,
    })
    expect(resolveShortcut(key('ArrowRight', { shiftKey: true }))).toEqual({
      type: 'nudge',
      dx: 10,
      dy: 0,
    })
    expect(resolveShortcut(key('ArrowUp'))).toEqual({
      type: 'nudge',
      dx: 0,
      dy: -1,
    })
    expect(resolveShortcut(key('ArrowDown', { shiftKey: true }))).toEqual({
      type: 'nudge',
      dx: 0,
      dy: 10,
    })
  })

  it('zoom and scope', () => {
    expect(resolveShortcut(key('0', { metaKey: true }))).toEqual({
      type: 'zoom',
      to: 'fit',
    })
    expect(resolveShortcut(key('1', { metaKey: true }))).toEqual({
      type: 'zoom',
      to: 'reset',
    })
    expect(resolveShortcut(key('@', { shiftKey: true }, 'Digit2'))).toEqual({
      type: 'zoom',
      to: 'selection',
    })
    expect(resolveShortcut(key('=', { metaKey: true }, 'Equal'))).toEqual({
      type: 'zoom',
      to: 'in',
    })
    expect(resolveShortcut(key('+', { metaKey: true, shiftKey: true }, 'Equal'))).toEqual({
      type: 'zoom',
      to: 'in',
    })
    expect(resolveShortcut(key('-', { ctrlKey: true }, 'Minus'))).toEqual({
      type: 'zoom',
      to: 'out',
    })
    expect(resolveShortcut(key('Enter'))).toEqual({
      type: 'scope',
      dir: 'enter',
    })
    expect(resolveShortcut(key('Escape'))).toEqual({
      type: 'scope',
      dir: 'exit',
    })
  })

  it('Ctrl+Shift+? opens the panel', () => {
    expect(resolveShortcut(key('?', { ctrlKey: true, shiftKey: true }, 'Slash'))).toEqual({
      type: 'shortcutsPanel',
    })
  })

  it('unknown keys and extra modifiers resolve to nothing', () => {
    expect(resolveShortcut(key('q'))).toBeNull()
    expect(resolveShortcut(key('v', { altKey: true, shiftKey: true }))).toBeNull()
    expect(resolveShortcut(key('d', { metaKey: true, shiftKey: true }))).toBeNull()
  })

  // Workspace/Terminal combos (Cmd+0/1/±, Cmd+digits) are pane-scoped and
  // are expected to be reused by the canvas.
  it('never collides with the global AppShell combos', () => {
    for (const cmd of COMMANDS.filter((c) => c.context === 'Global')) {
      const c = cmd.defaultCombo
      const facts = key(
        c.key ?? '',
        { ctrlKey: !!c.mod, shiftKey: !!c.shift, altKey: !!c.alt },
        c.code ?? '',
      )
      expect(resolveShortcut(facts), formatCombo(c)).toBeNull()
    }
  })

  it('every combo is unique across the table (including aliases)', () => {
    const combos = SHORTCUTS.flatMap((d) => [d.combo, ...(d.aliases ?? [])])
    for (let i = 0; i < combos.length; i++) {
      for (let j = i + 1; j < combos.length; j++) {
        const a = combos[i]
        const b = combos[j]
        const probe = key(
          a.key ?? '',
          { ctrlKey: !!a.mod, shiftKey: !!a.shift, altKey: !!a.alt },
          a.code ?? '',
        )
        const same = matchCombo(probe as KeyboardEvent, b)
        expect(same, `${formatCombo(a)} vs ${formatCombo(b)}`).toBe(false)
      }
    }
  })
})
