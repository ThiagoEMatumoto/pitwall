import { ipcMain, webContents } from 'electron'
import { z } from 'zod'
import { getDb } from '../services/db'
import { ptyManager } from '../services/pty-manager'
import { injectIntoSession } from '../services/handoff/inject'
import { getByChildSession } from '../services/handoff-store'
import { broadcast } from '../services/notify'
import { notify } from '../services/notifications'
import { tuiMenuWatch } from '../services/tui-menu-watch'
import { PromptQueue } from '../services/prompt-queue'
import { getDormantPanes } from '../services/dormant-panes'
import { emitSessionLinkPulse, setSendMessageObserver } from '../services/session-link-pulse'
import { MAX_TAIL_SUBSCRIPTIONS, ScreenTailFeed } from '../services/screen-tail'
import {
  buildSessionsFileIndex,
  isPidAlive,
  mapStatus,
  ptyStatusFor,
  sessionActivityService,
  setPromptQueueTurnHook,
} from '../services/session-activity'
import {
  handoffAsking,
  type LiveStatus,
  type ScreenScan,
} from '../../../shared/tui/attention-reason'
import { isAgentAskEnvelope } from '../../../shared/agent-ask'
import { setMotherNoteSender } from '../services/handoff/notify-mother-alias'
import { recordChildDirectMessage } from '../services/handoff/direct-message-trail'
import { answerCitedRequests } from '../services/handoff/cited-answer'
import { isHandoffWakeEnvelope } from '../../../shared/handoff-wake-envelope'
import { isHandoffAnswerEnvelope } from '../../../shared/handoff-answer-envelope'
import { onAnswerQueueSnapshot } from '../services/handoff/answer-delivery'
import {
  onQueueSnapshot,
  setHandoffWakeQueue,
  sweepOrphansOnBoot,
} from '../services/handoff/handoff-wake'
import type {
  PromptQueueSnapshot,
  ScreenPreview,
  SendPromptInput,
  SendPromptResult,
} from '../../../shared/types/send-prompt'

// Mandar prompt pra qualquer sessão viva sem abri-la. A escrita é a mesma do
// canal mãe→filha (injectIntoSession: bracketed-paste + \r); a decisão de QUANDO
// escrever mora na prompt-queue.

const PREVIEW_LINES = 6
// Linhas da saída ao vivo no cartão aberto do mapa. A mãe mostra 16 (MotherCard)
// depois de o renderer tirar a moldura da TUI; os cartões comuns usam as 10 últimas.
const TAIL_LINES = 20

const sendSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().trim().min(1).max(100_000),
  when: z.enum(['now', 'on-idle']),
  fromSessionId: z.string().min(1).optional(),
})
const idSchema = z.object({ id: z.string().min(1) })
const sessionSchema = z.object({ sessionId: z.string().min(1) })
const tailSubscribeSchema = z.object({
  sessionIds: z.array(z.string().min(1)).max(MAX_TAIL_SUBSCRIPTIONS),
})

function statusOf(ptyId: string): LiveStatus | null {
  // Provider sem índice nativo (Codex): o status é o da PTY.
  if (sessionActivityService.isPtyTracked(ptyId)) return ptyStatusFor(ptyId)
  const row = getDb().prepare('SELECT cc_session_id FROM sessions WHERE id = ?').get(ptyId) as
    { cc_session_id: string | null } | undefined
  if (!row?.cc_session_id) return null
  const entry = buildSessionsFileIndex().get(row.cc_session_id)
  if (!entry) return null
  return isPidAlive(entry.pid) ? mapStatus(entry.status) : 'ended'
}

// Sem espelho headless (Codex) não há tela: o Codex abre overlay de aprovação e a
// tela parada parece 'idle' — um \r ali aprovaria. null + status não nativo recusa
// os dois modos; quem quer falar com o Codex usa o terminal dele.
export function screenOf(id: string): Promise<ScreenScan | null> {
  return tuiMenuWatch.has(id) ? tuiMenuWatch.rescan(id) : Promise.resolve(null)
}

// O sessions.id de uma conversa que está dormindo no renderer não tem PTY: acorda
// a pane e manda para o id novo. Sem pane dormindo, o 'not-running' segue.
export async function sendWakingDormant(input: SendPromptInput): Promise<SendPromptResult> {
  const sent = await promptQueue.send(input)
  if (sent.ok || sent.error !== 'not-running') return sent
  const panes = getDormantPanes()
  const row = getDb()
    .prepare('SELECT cc_session_id FROM sessions WHERE id = ?')
    .get(input.sessionId) as { cc_session_id: string | null } | undefined
  const cc = row?.cc_session_id
  if (!panes || !cc || !panes.findDormantByCc(cc)) return sent
  const woke = await panes.wakeDormant(cc, 'send-prompt')
  if (!woke.ok) return sent
  // Recém-acordada ainda pode estar no turno do --resume: 'now' escreveria no meio
  // dele. A fila on-idle espera o idle/waiting certo.
  return promptQueue.send({ ...input, sessionId: woke.sessionId, when: 'on-idle' })
}

let lastNotifiedEventId: string | null = null

// Mensagem que não vai chegar nunca merece aviso fora do app: quem mandou
// "quando terminar" provavelmente já saiu dali.
function noticeLostMessage(snapshot: PromptQueueSnapshot): void {
  const ev = snapshot.lastEvent
  if (!ev || ev.id === lastNotifiedEventId) return
  if (ev.kind !== 'expired' && ev.kind !== 'session-gone') return
  // Pergunta de agente: quem perguntou fica sabendo pelo agent_check, não o usuário.
  if (isAgentAskEnvelope(ev.text)) return
  lastNotifiedEventId = ev.id
  // Aviso de handoff à mãe: o texto é o envelope inteiro, que não diz nada em 80
  // chars. Continua notificando — é o alarme fora do app quando o wake se perde.
  if (isHandoffWakeEnvelope(ev.text)) {
    notify({
      title: 'Mensagem não entregue',
      body: `A mãe não recebeu a atualização de handoff (${ev.kind === 'expired' ? '30 min na fila' : 'sessão encerrada'}).`,
    })
    return
  }
  if (isHandoffAnswerEnvelope(ev.text)) {
    notify({
      title: 'Resposta não entregue',
      body: `A resposta ao pedido de handoff não chegou (${ev.kind === 'expired' ? '30 min na fila' : 'sessão encerrada'}).`,
    })
    return
  }
  notify({
    title: 'Mensagem não entregue',
    body:
      ev.kind === 'expired'
        ? `Passou 30 min na fila sem a sessão terminar: "${ev.text.slice(0, 80)}"`
        : `A sessão encerrou antes de terminar o turno: "${ev.text.slice(0, 80)}"`,
  })
}

export const promptQueue = new PromptQueue({
  isRunning: (id) => ptyManager.isRunning(id),
  status: statusOf,
  screen: screenOf,
  nativeStatus: (id) => !sessionActivityService.isPtyTracked(id),
  handoffAsking: (id) => {
    const h = getByChildSession(id)
    return h ? handoffAsking(h) : false
  },
  write: (id, text) => injectIntoSession(id, text),
  // Origem que já morreu não tem cartão vivo no mapa para a bolinha sair.
  delivered: (to, from) => {
    if (from && ptyManager.isRunning(from)) {
      emitSessionLinkPulse({ fromSessionId: from, toSessionId: to, kind: 'message' })
    }
  },
  emit: (snapshot) => {
    broadcast('prompt-queue:updated', snapshot)
    noticeLostMessage(snapshot)
    try {
      onQueueSnapshot(snapshot)
      onAnswerQueueSnapshot(snapshot)
    } catch (err) {
      console.error('[handoff-wake] snapshot da fila não atualizou o ledger:', err)
    }
  },
  warn: (event) => console.warn(JSON.stringify(event)),
})

const tailFeed = new ScreenTailFeed({
  read: (id) => tuiMenuWatch.styledTail(id, TAIL_LINES),
  send: (subscriber, update) => {
    const wc = webContents.fromId(subscriber)
    if (wc && !wc.isDestroyed()) wc.send('sessions:tail', update)
  },
})

let registered = false

export function registerSendPromptIpc(): void {
  if (registered) return
  registered = true
  // A borda vem por ccSessionId; a fila é por PTY. Só PTY espelhada entra em
  // 'quando terminar', e o espelho é quem guarda o cc→pty. Sessão sem id nativo
  // (Codex) já chega pelo sessions.id, que é o próprio id da PTY.
  setPromptQueueTurnHook((key) => {
    const ptyId =
      tuiMenuWatch.ptyForCc(key) ?? (sessionActivityService.isPtyTracked(key) ? key : null)
    if (ptyId) promptQueue.onTurnEnded(ptyId)
  })
  ptyManager.on('exit', (e) => promptQueue.onSessionExit(e.sessionId))
  setMotherNoteSender((input) => promptQueue.send(input))
  setHandoffWakeQueue({
    send: (input) => promptQueue.send(input),
    replaceText: (id, text) => promptQueue.replaceText(id, text),
    cancel: (id) => promptQueue.cancel(id),
  })
  sweepOrphansOnBoot()
  setSendMessageObserver((e) => {
    recordChildDirectMessage(e)
    const answered = answerCitedRequests(e)
    if (answered) broadcast('handoff:updated', answered)
  })
  ptyManager.on('data', (e) => tailFeed.onData(e.sessionId))
  ptyManager.on('exit', (e) => tailFeed.onExit(e.sessionId))

  ipcMain.handle('sessions:send-prompt', (_e, raw: unknown) => {
    const input: SendPromptInput = sendSchema.parse(raw)
    return sendWakingDormant(input)
  })
  ipcMain.handle('prompt-queue:cancel', (_e, raw: unknown) => {
    const { id } = idSchema.parse(raw)
    return promptQueue.cancel(id)
  })
  ipcMain.handle('prompt-queue:list', () => promptQueue.snapshot())
  // A janela diz quais cartões estão abertos E visíveis; cada chamada substitui a
  // lista anterior (o mapa desmontando manda []). Janela fechada solta as dela.
  const tailSubscribers = new Set<number>()
  ipcMain.handle('sessions:tail-subscribe', (e, raw: unknown) => {
    const { sessionIds } = tailSubscribeSchema.parse(raw)
    const id = e.sender.id
    if (!tailSubscribers.has(id)) {
      tailSubscribers.add(id)
      const release = () => {
        tailSubscribers.delete(id)
        tailFeed.drop(id)
      }
      e.sender.once('destroyed', release)
    }
    tailFeed.subscribe(id, sessionIds)
  })
  ipcMain.handle('sessions:screen-preview', async (_e, raw: unknown) => {
    const { sessionId } = sessionSchema.parse(raw)
    const lines = await tuiMenuWatch.screenTail(sessionId, PREVIEW_LINES)
    if (!lines) return null
    const preview: ScreenPreview = {
      lines,
      hasMenu: tuiMenuWatch.current(sessionId)?.menu != null,
      inputDirty: tuiMenuWatch.current(sessionId)?.inputDirty === true,
    }
    return preview
  })
}
