// Aviso automático à MÃE quando a passagem de bastão troca o endereço da filha.
//
// O apelido é o endereço do `SendMessage({ to })`. Como a antecessora continua
// VIVA (decisão de produto), a sucessora precisa desambiguar e o endereço muda —
// e enquanto ninguém avisa a mãe, todo SendMessage dela para o nome antigo é
// entregue à ANTECESSORA. Não é uma falha visível: a mensagem chega, na sessão
// errada, e a mãe segue supervisionando um endereço morto.
//
// A nota vai pro REPL da mãe pela fila on-idle (a mesma do agent-bus), não por
// write cru no PTY: a nota termina em Enter, e escrita direta sobre um menu de
// permissão aberto o aprovaria — ou enviaria junto o rascunho que a mãe digitava.
// A fila segura a nota (menu, rascunho, tela não reconhecida) e entrega no fim do
// turno. O aviso da UI continua — ele deixa de ser a única linha de defesa.
//
// Degrada em SILÊNCIO: mãe inexistente, encerrada ou fila recusando não é erro
// nenhum (o bastão já foi passado com sucesso; isto é notificação).

import { ptyManager } from '../pty-manager'
import * as store from '../handoff-store'
import { sanitizeBody } from '../agent-bus'
import { injectIntoChildGuarded } from './guarded-inject'
import { emitSessionLinkPulse } from '../session-link-pulse'
import type { Handoff } from '../../../../shared/types/ipc'
import type { SendPromptInput, SendPromptResult } from '../../../../shared/types/send-prompt'

// Setter em vez de import: a fila vive em ipc/send-prompt (que puxa electron), e
// este serviço é carregado por quem não deve depender da camada de IPC.
type MotherNoteSender = (input: SendPromptInput) => Promise<SendPromptResult>
let sendToMother: MotherNoteSender | null = null

export function setMotherNoteSender(fn: MotherNoteSender | null): void {
  sendToMother = fn
}

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
  // Segurada na fila da mãe (menu/rascunho/turno em curso): sai no fim do turno.
  queued?: boolean
  // Por que não entregou — só pra log/teste; ninguém trata isto como falha.
  reason?:
    | 'handoff-not-found'
    | 'no-mother'
    | 'mother-not-running'
    | 'no-queue'
    | 'send-refused'
    | 'send-failed'
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

// Entrega a nota à mãe do handoff pela fila on-idle. Best-effort por contrato.
export async function notifyMotherOfAliasChange(
  args: AliasChangeNotice,
): Promise<AliasChangeDelivery> {
  const handoff = store.get(args.handoffId)
  if (!handoff) return { delivered: false, reason: 'handoff-not-found' }

  const mother = handoff.motherSessionId
  if (!mother) return { delivered: false, reason: 'no-mother' }
  if (!ptyManager.isRunning(mother)) return { delivered: false, reason: 'mother-not-running' }
  if (!sendToMother) return { delivered: false, reason: 'no-queue' }

  try {
    const sent = await sendToMother({
      sessionId: mother,
      // Os apelidos vêm de nome de sessão: um ESC[201~ ali fecharia o paste.
      text: sanitizeBody(buildAliasChangeNote(args)),
      when: 'on-idle',
      // Quem "fala" é a sucessora, já relinkada: a fila pulsa o mapa na escrita real.
      fromSessionId: handoff.childSessionId ?? undefined,
    })
    if (!sent.ok) {
      console.warn(`[baton] fila recusou o aviso de troca de apelido à mãe: ${sent.error}`)
      return { delivered: false, reason: 'send-refused' }
    }
    return sent.delivered ? { delivered: true } : { delivered: false, queued: true }
  } catch (err) {
    console.error('[baton] aviso de troca de apelido não chegou à mãe:', err)
    return { delivered: false, reason: 'send-failed' }
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
