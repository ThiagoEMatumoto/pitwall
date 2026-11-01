// O envelope que o acordador da mãe (handoff-wake) cola no REPL dela pela fila
// on-idle. Main e renderer precisam reconhecê-lo: chega como turno 'user', mas
// quem escreveu foi o Pitwall, não o usuário.
export const HANDOFF_WAKE_TAG = 'pitwall-handoff-update'

export function isHandoffWakeEnvelope(text: string): boolean {
  return text.trimStart().startsWith(`<${HANDOFF_WAKE_TAG}`)
}

export interface HandoffWakeUpdate {
  handoffId: string
  alias: string | null
  status: string
  reasons: string[]
  body: string
  truncated: boolean
}

export interface HandoffWakeEnvelope {
  updates: HandoffWakeUpdate[]
  // "+N atualizações não mostradas": o produtor corta em WAKE_MAX_BLOCKS.
  overflow: number
}

const UPDATE_RE = /<update ([^>]*)>\n([\s\S]*?)\n<\/update>/g
const ATTR_RE = /([a-z-]+)="([^"]*)"/g
const OVERFLOW_RE = /^\+(\d+) atualizaç/m

function attrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of raw.matchAll(ATTR_RE)) out[m[1]] = m[2]
  return out
}

// Lê o bloco montado por formatWakeEnvelope (electron/main/services/handoff/handoff-wake.ts).
// O corpo sai como o produtor escapou (`<\/update`): é exibição, não reinjeção.
export function parseHandoffWakeEnvelope(text: string): HandoffWakeEnvelope | null {
  if (!isHandoffWakeEnvelope(text)) return null
  const updates: HandoffWakeUpdate[] = []
  for (const m of text.matchAll(UPDATE_RE)) {
    const a = attrsOf(m[1])
    if (!a['handoff-id']) continue
    updates.push({
      handoffId: a['handoff-id'],
      alias: a.alias || null,
      status: a.status ?? '',
      reasons: (a.reason ?? '').split(',').filter(Boolean),
      body: m[2],
      truncated: a.truncated === 'true',
    })
  }
  const overflow = Number(OVERFLOW_RE.exec(text)?.[1] ?? 0)
  return { updates, overflow }
}
