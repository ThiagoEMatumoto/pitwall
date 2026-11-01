// O envelope que o acordador da mãe (handoff-wake) cola no REPL dela pela fila
// on-idle. Main e renderer precisam reconhecê-lo: chega como turno 'user', mas
// quem escreveu foi o Pitwall, não o usuário.
export const HANDOFF_WAKE_TAG = 'pitwall-handoff-update'

// O REPL (2.1.316) grava no transcript a colagem do envelope embrulhada:
// "\n\n<pasted_content id=\"N\">\n…\n</pasted_content id=\"N\">\n". A fila guarda o
// texto cru; o chat e a Room leem o embrulhado.
const PASTED_WRAP_RE = /^\s*<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>\s*$/

function unwrapPasted(text: string): string {
  return PASTED_WRAP_RE.exec(text)?.[1] ?? text
}

export function isHandoffWakeEnvelope(text: string): boolean {
  return unwrapPasted(text).trimStart().startsWith(`<${HANDOFF_WAKE_TAG}`)
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
  const raw = unwrapPasted(text)
  if (!isHandoffWakeEnvelope(raw)) return null
  const updates: HandoffWakeUpdate[] = []
  for (const m of raw.matchAll(UPDATE_RE)) {
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
  const overflow = Number(OVERFLOW_RE.exec(raw)?.[1] ?? 0)
  return { updates, overflow }
}
