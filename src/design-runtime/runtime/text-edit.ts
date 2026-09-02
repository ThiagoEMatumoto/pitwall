// In-place text editing: one contenteditable session at a time, committed
// on Enter / blur and reverted on Escape.

import { readNodeText, requireEl, setNodeText } from './dom'
import { PROTOCOL_VERSION, post } from './messaging'

interface TextEditSession {
  id: string
  el: HTMLElement
  original: string
  onKeyDown: (e: KeyboardEvent) => void
  onBlur: () => void
}

let textEdit: TextEditSession | null = null

function endTextEdit(reason: 'commit' | 'escape' | 'blur'): void {
  const session = textEdit
  if (!session) return
  textEdit = null
  const { el, id, original } = session
  el.removeEventListener('keydown', session.onKeyDown)
  el.removeEventListener('blur', session.onBlur)
  const text = reason === 'escape' ? original : readNodeText(el)
  el.contentEditable = 'false'
  el.removeAttribute('contenteditable')
  // Normalise whatever contenteditable produced back to the model shape.
  setNodeText(el, text)
  el.blur()
  post({ v: PROTOCOL_VERSION, type: 'textEditEnd', id, text, reason })
}

export function startTextEdit(id: string): void {
  if (textEdit) endTextEdit('blur')
  const el = requireEl(id)
  const session: TextEditSession = {
    id,
    el,
    original: readNodeText(el),
    onKeyDown: (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        endTextEdit('escape')
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        endTextEdit('commit')
      }
    },
    onBlur: () => endTextEdit('blur'),
  }
  textEdit = session
  el.contentEditable = 'plaintext-only'
  el.addEventListener('keydown', session.onKeyDown)
  el.addEventListener('blur', session.onBlur)
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}
