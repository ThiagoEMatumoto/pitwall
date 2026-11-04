import { useRef, useState } from 'react'
import type { InputBoxState } from '../../../../shared/tui/input-draft'
import {
  isRewindPicker,
  REWIND_NAV_DELAY_MS,
  REWIND_OPEN_DELAY_MS,
  REWIND_OPEN_KEYS,
  rewindCursorOnTarget,
  rewindNavKeys,
  type RewindTarget,
} from '../../../../shared/tui/rewind'
import type { TuiMenu } from '../../../../shared/tui/tui-menu-parser'

interface Deps {
  status?: string
  onRespond?: (seqs: string[], delayMs?: number) => void | Promise<boolean | void>
  reparseMenu?: () => TuiMenu | null
  pickerOpen: boolean
  readCliInput?: () => InputBoxState
}

const OPEN_TIMEOUT_MS = 3000
const NAV_TIMEOUT_MS = 2500
const POLL_MS = 120

async function poll<T>(read: () => T | null, timeoutMs: number): Promise<T | null> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = read()
    if (v != null) return v
    if (Date.now() >= end) return null
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

// "Voltar a este ponto": abre o seletor do /rewind (Esc-Esc), anda até a mensagem e abre o
// submenu dela. Para antes de qualquer restauração: o que restaurar é clique do usuário
// no card do submenu. Se o seletor não confirmar a mensagem na tela, ele fica aberto no
// card genérico para o usuário escolher.
export function useRewind({ status, onRespond, reparseMenu, pickerOpen, readCliInput }: Deps) {
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const available = onRespond != null && reparseMenu != null && readCliInput != null

  function blockedReason(): string | null {
    if (status !== 'idle') return 'Espere o Claude terminar para voltar a um ponto.'
    if (pickerOpen || reparseMenu?.() != null) return 'Feche o diálogo aberto no terminal antes.'
    const input = readCliInput?.()
    if (!input?.prompt) return 'Não achei a caixa de input do terminal.'
    // Com texto, o 1º Esc-Esc só limpa a caixa (sonda history-rewind-compact).
    if (input.draft) return 'A caixa do terminal tem texto: envie ou limpe antes de voltar.'
    return null
  }

  async function run(target: RewindTarget) {
    const respond = async (keys: string[], delay?: number) =>
      (await Promise.resolve(onRespond!(keys, delay))) !== false
    if (!(await respond(REWIND_OPEN_KEYS, REWIND_OPEN_DELAY_MS))) {
      return 'Outra resposta ainda está sendo digitada no terminal.'
    }
    const picker = await poll(() => {
      const m = reparseMenu!()
      return isRewindPicker(m) ? m : null
    }, OPEN_TIMEOUT_MS)
    if (!picker) return 'O seletor de rewind não abriu no terminal.'
    const keys = rewindNavKeys(picker, target)
    const fallback = 'Não achei essa mensagem no seletor com certeza: escolha nele abaixo.'
    if (keys == null) return fallback
    if (keys.length > 0 && !(await respond(keys, REWIND_NAV_DELAY_MS))) return fallback
    const at = await poll(() => {
      const m = reparseMenu!()
      return m && rewindCursorOnTarget(m, target) ? m : null
    }, NAV_TIMEOUT_MS)
    if (!at) return fallback
    // Enter no seletor só abre o submenu daquela mensagem; nada é restaurado ainda.
    if (!(await respond(['\r']))) return fallback
    return null
  }

  async function start(target: RewindTarget) {
    if (!available || busyRef.current) return
    const blocked = blockedReason()
    if (blocked) return setNotice(blocked)
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    try {
      setNotice(await run(target))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return { available, busy, notice, start, announce: setNotice, dismiss: () => setNotice(null) }
}
