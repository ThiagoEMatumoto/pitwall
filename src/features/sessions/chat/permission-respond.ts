import type {
  AttentionAction,
  AttentionMenuSnapshot,
  AttentionRespondInput,
  AttentionRespondResult,
  TuiMenu,
} from '../../../../shared/types/ipc'

export interface GuardedRespondApi {
  attentionMenu(sessionId: string): Promise<AttentionMenuSnapshot | null>
  attentionRespond(input: AttentionRespondInput): Promise<AttentionRespondResult>
}

export type GuardedRespondResult =
  | { ok: true }
  // no-watch: o main não tem menu desta sessão (espelho não armado ou o prompt já
  // saiu da tela) — quem chamou decide se cai no write local.
  | {
      ok: false
      error:
        'no-watch' | 'decision-changed' | Extract<AttentionRespondResult, { ok: false }>['error']
    }

// O card e o main leem a mesma tela por espelhos diferentes; o context pode
// diferir num redesenho, então a conferência é pelo que a pessoa decidiu: mesmo
// tipo de prompt, mesma pergunta, mesmo pedido e mesma opção naquele índice.
export function sameDecision(shown: TuiMenu, fresh: TuiMenu, optionIndex: number): boolean {
  const label = (m: TuiMenu) => m.options.find((o) => o.index === optionIndex)?.label
  return (
    shown.kind === fresh.kind &&
    (shown.question ?? '') === (fresh.question ?? '') &&
    (shown.request?.tool ?? '') === (fresh.request?.tool ?? '') &&
    (shown.request?.command ?? '') === (fresh.request?.command ?? '') &&
    label(shown) != null &&
    label(shown) === label(fresh)
  )
}

// Resposta pelo caminho do main (fingerprint + menuSeq + trava + attention_responses),
// o mesmo do AttentionPopover: funciona sem xterm montado e deixa telemetria.
export async function respondGuarded(
  api: GuardedRespondApi,
  sessionId: string,
  shown: TuiMenu,
  action: AttentionAction,
): Promise<GuardedRespondResult> {
  const snap = await api.attentionMenu(sessionId)
  if (!snap) return { ok: false, error: 'no-watch' }
  if (!sameDecision(shown, snap.menu, action.optionIndex))
    return { ok: false, error: 'decision-changed' }
  const res = await api.attentionRespond({
    sessionId,
    fingerprint: snap.fingerprint,
    menuSeq: snap.menuSeq,
    action,
  })
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

export const RESPOND_NOTICE: Record<Exclude<GuardedRespondResult, { ok: true }>['error'], string> =
  {
    'no-watch': 'O pedido já não está na tela desta sessão.',
    'decision-changed': 'O pedido mudou enquanto você decidia — confira de novo.',
    'menu-changed': 'O pedido mudou enquanto você decidia — confira de novo.',
    'no-menu': 'O pedido já não está na tela desta sessão.',
    'not-running': 'A sessão encerrou.',
    'invalid-action': 'Essa opção não existe mais no pedido.',
    busy: 'Outra resposta a este pedido já está a caminho.',
  }
