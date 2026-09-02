// Cheat sheet of the canvas keymap (Ctrl+Shift+?). Self-contained: it opens
// on the toggle event dispatched by useCanvasShortcuts, so the host only
// needs to render <ShortcutsPanel />.

import { useEffect, useState } from 'react'
import { Keyboard } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import type { Combo } from '@/lib/keybindings'
import { SHORTCUTS, type ShortcutDef, type ShortcutGroup } from './canvas/shortcuts-map'
import { SHORTCUTS_PANEL_TOGGLE_EVENT } from './canvas/useCanvasShortcuts'

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

const KEY_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Enter: '↵',
  Escape: 'Esc',
  Delete: 'Del',
  Backspace: '⌫',
}

const CODE_LABELS: Record<string, string> = {
  BracketRight: ']',
  BracketLeft: '[',
  Equal: '=',
  Minus: '-',
  Slash: '?',
}

const GROUPS: readonly ShortcutGroup[] = [
  'Ferramentas',
  'Edição',
  'Arranjo',
  'Alinhamento',
  'Navegação',
]

function comboLabel(c: Combo): string {
  const parts: string[] = []
  if (c.mod) parts.push(isMac ? '⌘' : 'Ctrl')
  if (c.alt) parts.push(isMac ? '⌥' : 'Alt')
  if (c.shift) parts.push('⇧')
  if (c.code) parts.push(CODE_LABELS[c.code] ?? c.code.replace(/^Key/, ''))
  else if (c.key) parts.push(KEY_LABELS[c.key] ?? c.key.toUpperCase())
  return parts.join(' ')
}

// Arrow nudges collapse into one row per step size.
function rows(group: ShortcutGroup): Array<{ label: string; keys: string[] }> {
  const out: Array<{ label: string; keys: string[] }> = []
  const nudges = new Map<string, string[]>()
  for (const def of SHORTCUTS.filter((d) => d.group === group)) {
    if (def.action.type === 'nudge') {
      const label = def.combo.shift ? 'Mover 10px' : 'Mover 1px'
      nudges.set(label, [...(nudges.get(label) ?? []), comboLabel(def.combo)])
      continue
    }
    out.push({ label: def.label, keys: keysOf(def) })
  }
  for (const [label, keys] of nudges) out.push({ label, keys: [keys.join(' ')] })
  return out
}

function keysOf(def: ShortcutDef): string[] {
  // Numpad aliases only add noise to the sheet.
  const aliases = (def.aliases ?? []).filter((a) => !a.code?.startsWith('Numpad'))
  return [def.combo, ...aliases].map(comboLabel)
}

export function ShortcutsPanel() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const toggle = (): void => setOpen((v) => !v)
    window.addEventListener(SHORTCUTS_PANEL_TOGGLE_EVENT, toggle)
    return () => window.removeEventListener(SHORTCUTS_PANEL_TOGGLE_EVENT, toggle)
  }, [])

  // Escape closes the sheet before the canvas shortcuts (capture) see it.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Atalhos do canvas"
      widthClassName="w-[40rem]"
    >
      <div className="flex items-center gap-2 pb-3 text-xs text-[var(--color-text-muted)]">
        <Keyboard size={14} aria-hidden />
        Atalhos ativos com o canvas em modo de edição.
      </div>
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 overflow-y-auto sm:grid-cols-2">
        {GROUPS.map((group) => (
          <section key={group}>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              {group}
            </h3>
            <ul className="space-y-1">
              {rows(group).map((row) => (
                <li
                  key={`${group}:${row.label}`}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="text-[var(--color-text)]">{row.label}</span>
                  <span className="flex shrink-0 gap-1">
                    {row.keys.map((k) => (
                      <kbd
                        key={k}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text-muted)]"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
