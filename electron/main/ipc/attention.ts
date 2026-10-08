import { ipcMain } from 'electron'
import { broadcast, onBroadcast } from '../services/notify'
import { tuiMenuWatch } from '../services/tui-menu-watch'
import { attentionCounters, computeAttention } from '../services/attention/attention-service'
import type { AttentionCounters, AttentionItem } from '../../../shared/types/attention'

// O que muda a fila: handoffs (ask/progress/report/fail/dismiss), o batch global
// de atividade (status waiting), a morte da PTY e a feature da sessão. NUNCA
// 'attention:' — o próprio push se realimentaria.
const ATTENTION_CHANNEL_PREFIXES = [
  'handoff:',
  'session:activity:global',
  'pty:exit',
  'session:feature-changed',
] as const
export const ATTENTION_PUSH_DELAY_MS = 300

// Mesmo coalescing de watchSessionGraph: o 1º evento arma, os seguintes pegam carona.
export function watchAttention(push: () => void, delayMs = ATTENTION_PUSH_DELAY_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      push()
    }, delayMs)
  }
  const offs = ATTENTION_CHANNEL_PREFIXES.map((prefix) => onBroadcast(prefix, schedule))
  // O menu da TUI não passa pelo broadcast: é um EventEmitter próprio.
  tuiMenuWatch.on('change', schedule)
  return () => {
    for (const off of offs) off()
    tuiMenuWatch.removeListener('change', schedule)
    if (timer) clearTimeout(timer)
    timer = null
  }
}

// Só emite quando a lista mudou: a projeção é determinística, então o JSON
// serializado é a identidade da lista.
export function createAttentionPusher(
  compute: () => AttentionItem[],
  send: (items: AttentionItem[]) => void,
): () => void {
  let last = ''
  return () => {
    const items = compute()
    const serialized = JSON.stringify(items)
    if (serialized === last) return
    last = serialized
    send(items)
  }
}

export function registerAttentionIpc(): void {
  ipcMain.handle('attention:list', (): AttentionItem[] => computeAttention())
  ipcMain.handle('attention:debug', (): AttentionCounters => attentionCounters())
  watchAttention(
    createAttentionPusher(
      () => computeAttention(),
      (items) => broadcast('attention:changed', items),
    ),
  )
}
