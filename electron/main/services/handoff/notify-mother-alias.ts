// Aviso automático à MÃE quando a passagem de bastão troca o endereço da filha.
//
// O apelido é o endereço do `SendMessage({ to })`. Como a antecessora continua
// VIVA (decisão de produto), a sucessora precisa desambiguar e o endereço muda —
// e enquanto ninguém avisa a mãe, todo SendMessage dela para o nome antigo é
// entregue à ANTECESSORA. Não é uma falha visível: a mensagem chega, na sessão
// errada, e a mãe segue supervisionando um endereço morto.
//
// Até aqui a única mitigação era um aviso na UI pedindo que o HUMANO avisasse a
// mãe. O app já tem o mecanismo pra se resolver sozinho: o mesmo seam de PTY que
// o handoff_message usa pra falar com uma filha. Então a nota vai direto pro REPL
// da mãe. O aviso da UI continua — ele deixa de ser a única linha de defesa.
//
// Degrada em SILÊNCIO: mãe inexistente, encerrada ou PTY que morreu no meio não é
// erro nenhum (o bastão já foi passado com sucesso; isto é notificação).

import { ptyManager } from '../pty-manager'
import * as store from '../handoff-store'
import { injectIntoSession } from './inject'
import { injectIntoChildGuarded } from './guarded-inject'
import { emitSessionLinkPulse } from '../session-link-pulse'
import type { Handoff } from '../../../../shared/types/ipc'

export interface AliasChangeNotice {
  handoffId: string
  // Endereço NOVO (o da sucessora, que já subiu).
  alias: string
  // Endereço antigo, que a antecessora viva ainda atende. Opcional: sem ele a
  // nota diz o que importa mesmo assim (qual é o endereço válido agora).
  previousAlias?: string | null
}

export interface AliasChangeDelivery {
  delivered: boolean
  // Por que não entregou — só pra log/teste; ninguém trata isto como falha.
  reason?: 'handoff-not-found' | 'no-mother' | 'mother-not-running' | 'inject-failed'
}

// Texto da nota. PURO (testável sem PTY): é o que a mãe lê no próprio REPL.
// Nomeia as duas pontas porque a mãe pode estar supervisionando várias filhas —
// "o endereço mudou" sem dizer QUAL não ajuda em nada.
export function buildAliasChangeNote(args: AliasChangeNotice): string {
  const from = args.previousAlias?.trim()
  return [
    '[Pitwall] Passagem de bastão: o endereço de uma filha sua MUDOU.',
    from
      ? `- A sessão "${from}" encheu o contexto e passou o trabalho para "${args.alias}".`
      : `- Quem responde por este trabalho agora é "${args.alias}".`,
    `- handoffId: ${args.handoffId}`,
    from
      ? `- Use SendMessage({ to: "${args.alias}" }) daqui pra frente. O apelido "${from}" ainda existe (a sessão anterior continua viva), então mandar pra lá NÃO dá erro — a mensagem só chega em quem não está mais no trabalho.`
      : `- Use SendMessage({ to: "${args.alias}" }) daqui pra frente.`,
  ].join('\n')
}

// Entrega a nota no PTY da mãe do handoff. Best-effort por contrato.
export function notifyMotherOfAliasChange(args: AliasChangeNotice): AliasChangeDelivery {
  const handoff = store.get(args.handoffId)
  if (!handoff) return { delivered: false, reason: 'handoff-not-found' }

  const mother = handoff.motherSessionId
  if (!mother) return { delivered: false, reason: 'no-mother' }
  if (!ptyManager.isRunning(mother)) return { delivered: false, reason: 'mother-not-running' }

  try {
    injectIntoSession(mother, buildAliasChangeNote(args))
    // Quem "fala" é a sucessora, já relinkada como filha deste handoff.
    emitSessionLinkPulse({ fromSessionId: handoff.childSessionId, toSessionId: mother, kind: 'note' })
    return { delivered: true }
  } catch (err) {
    // Corrida com a mãe encerrando entre o isRunning e o write.
    console.error('[baton] aviso de troca de apelido não chegou à mãe:', err)
    return { delivered: false, reason: 'inject-failed' }
  }
}

// ---- Bastão da MÃE: o lado inverso. Quem muda de endereço é a mãe, e quem
// precisa saber são as filhas — cada uma responde (SendMessage) a quem escreveu
// primeiro, e continuaria escrevendo para a antecessora viva.

export interface ChildMotherNotice {
  handoffId: string
  // Endereço da sucessora (a nova mãe).
  alias: string
  // Endereço da antecessora, que segue viva e ainda atende por ele.
  previousAlias?: string | null
}

export function buildChildMotherNote(args: ChildMotherNotice): string {
  const from = args.previousAlias?.trim()
  return [
    `[Pitwall] Sua mãe agora é "${args.alias}"${from ? ` (antes "${from}", que passou o bastão)` : ''}.`,
    // A nota sai logo após o spawn: a sucessora ainda está subindo e o endereço
    // dela pode nem existir. É ela quem abre o canal (o kickoff manda escrever a
    // cada filha) — a filha que respondesse já cairia no vazio ou na antecessora.
    `- Ela ainda está subindo e vai te escrever primeiro: espere essa mensagem e só então use SendMessage({ to: "${args.alias}" }).`,
    from
      ? `- "${from}" continua viva: mandar pra lá não dá erro, só chega em quem não lidera mais.`
      : null,
    `- O handoff segue o mesmo (handoffId: ${args.handoffId}); até lá, reporte por handoff_progress/handoff_ask/handoff_report, que já vão para a nova mãe.`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n')
}

export interface ChildMotherDelivery {
  handoffId: string
  delivered: boolean
  reason?: 'no-child' | 'child-not-running' | 'inject-refused'
}

// Best-effort por filha, pelo guarded-inject: a nota termina em Enter, e um Enter
// sobre um menu de permissão aberto o aprovaria. Recusa vira motivo, não exceção —
// o bastão já foi passado e o relink no banco já vale.
export async function notifyChildrenOfNewMother(args: {
  handoffs: Pick<Handoff, 'id' | 'childSessionId'>[]
  alias: string
  previousAlias?: string | null
  // sessions.id da nova mãe: no mapa, a nota sai dela.
  fromSessionId?: string | null
}): Promise<ChildMotherDelivery[]> {
  const out: ChildMotherDelivery[] = []
  for (const h of args.handoffs) {
    const child = h.childSessionId
    if (!child) {
      out.push({ handoffId: h.id, delivered: false, reason: 'no-child' })
      continue
    }
    if (!ptyManager.isRunning(child)) {
      out.push({ handoffId: h.id, delivered: false, reason: 'child-not-running' })
      continue
    }
    try {
      await injectIntoChildGuarded(
        child,
        buildChildMotherNote({
          handoffId: h.id,
          alias: args.alias,
          previousAlias: args.previousAlias,
        }),
      )
      out.push({ handoffId: h.id, delivered: true })
      emitSessionLinkPulse({ fromSessionId: args.fromSessionId, toSessionId: child, kind: 'note' })
    } catch (err) {
      console.error(`[baton] nota da nova mãe não chegou à filha ${child}:`, err)
      out.push({ handoffId: h.id, delivered: false, reason: 'inject-refused' })
    }
  }
  return out
}
