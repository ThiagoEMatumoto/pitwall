import { useEffect, useRef, useState } from 'react'
import { handoffsApi, sessionsApi } from '@/lib/ipc'
import type { AttentionAction, TuiMenu } from '../../../../shared/types/ipc'
import { deriveChildAllowRule } from '../../../../electron/main/services/spawn-flags'
import { buildDigitKey } from './respond-keys'
import { gateMenuByStatus, menuFingerprint } from '../tui-menu-parser'
import type { PermissionDecision } from './PermissionCard'
import { RESPOND_NOTICE, respondGuarded, sameDecision } from './permission-respond'

// Quanto o "Enviado" segura o card: o amend redesenha as opções enquanto digita
// (o label do No vira o texto), e sem isso o card voltaria clicável no meio.
const SENT_HOLD_MS = 3000
// Sem PTY local (quick look em chat), o menu vem do espelho headless do main.
const MAIN_POLL_MS = 1200

interface Options {
  sessionId: string
  menu: TuiMenu | null
  isChild?: boolean
  // Guard do write local, usado só quando o main não acompanha esta sessão.
  reparseMenu?: () => TuiMenu | null
  onRespond?: (seqs: string[]) => void
}

export function usePermissionResponder({
  sessionId,
  menu,
  isChild,
  reparseMenu,
  onRespond,
}: Options) {
  const fp = menu ? menuFingerprint(menu) : null
  const [sent, setSent] = useState<{ label: string; until: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const inflight = useRef(false)

  // Prompt sumiu: some o card (e o "Enviado"). Prompt novo: aviso velho não vale.
  useEffect(() => {
    if (fp == null) setSent(null)
  }, [fp])
  useEffect(() => {
    setNotice(null)
  }, [fp])
  useEffect(() => {
    if (!sent) return
    const t = setTimeout(() => setSent(null), Math.max(0, sent.until - Date.now()))
    return () => clearTimeout(t)
  }, [sent])

  const childRule =
    isChild && menu?.kind === 'permission'
      ? deriveChildAllowRule(menu.request?.tool, menu.request?.command)
      : null

  async function send(shown: TuiMenu, action: AttentionAction): Promise<boolean> {
    const res = await respondGuarded(sessionsApi, sessionId, shown, action)
    if (res.ok) return true
    // Main sem espelho desta sessão, mas a tela local ainda mostra o mesmo prompt:
    // write local guardado pelo re-parse (amend exige o caminho do main).
    if (res.error === 'no-watch' && action.kind === 'select' && onRespond) {
      const fresh = reparseMenu?.() ?? null
      if (fresh && sameDecision(shown, fresh, action.optionIndex)) {
        const keys = buildDigitKey(action.optionIndex)
        if (keys.length > 0) {
          onRespond(keys)
          return true
        }
      }
    }
    setNotice(RESPOND_NOTICE[res.error])
    return false
  }

  async function decide(d: PermissionDecision) {
    if (!menu || inflight.current) return
    inflight.current = true
    setNotice(null)
    setSent({ label: d.label, until: Date.now() + SENT_HOLD_MS })
    try {
      let ok: boolean
      if (d.type === 'children') {
        const learned = await handoffsApi.learnChildRule({
          tool: menu.request?.tool,
          command: menu.request?.command,
        })
        if (!learned.ok) {
          setNotice(learned.reason)
          ok = false
        } else ok = await send(menu, { kind: 'select', optionIndex: d.optionIndex })
      } else if (d.type === 'amend') {
        ok = await send(menu, { kind: 'amend', optionIndex: d.optionIndex, text: d.text })
      } else ok = await send(menu, { kind: 'select', optionIndex: d.optionIndex })
      if (!ok) setSent(null)
    } finally {
      inflight.current = false
    }
  }

  return { sentLabel: sent?.label, notice, childRule, decide }
}

// Menu de permissão/trust lido do main, para o chat que não monta xterm.
export function useMainPermissionMenu(
  sessionId: string,
  enabled: boolean,
  status: string | undefined,
): TuiMenu | null {
  const [menu, setMenu] = useState<TuiMenu | null>(null)
  useEffect(() => {
    // Mesmos status do gate do card: trust e permissão também aparecem em
    // starting/idle, e o quick look não tem outro lugar que os mostre.
    if (!enabled || (status !== 'waiting' && status !== 'starting' && status !== 'idle')) {
      setMenu(null)
      return
    }
    let alive = true
    const read = () =>
      void sessionsApi.attentionMenu(sessionId).then((snap) => {
        if (!alive) return
        const gated = snap ? gateMenuByStatus(snap.menu, status) : null
        const next = gated && (gated.kind === 'permission' || gated.kind === 'trust') ? gated : null
        setMenu((prev) =>
          prev && next && menuFingerprint(prev) === menuFingerprint(next) ? prev : next,
        )
      })
    read()
    const t = setInterval(read, MAIN_POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [sessionId, enabled, status])
  return menu
}
