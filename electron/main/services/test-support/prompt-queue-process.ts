// Processo filho de prompt-queue.process.test.ts. Roda a PromptQueue real com o
// store real sobre o app.db aberto pelo caminho de produção (openAppDb). Só a PTY
// é falsa: write() registra, e a tela é a captura real que o pai passa em JSON.
//
//   enqueue <dbPath> <scan> <ptyId> <text> <stage>
//     stage = queued | before-write | after-write | delivered
//     Avisa o pai no estágio pedido e trava (o pai manda SIGKILL):
//     - queued: send() respondeu 'queued' (sessão trabalhando);
//     - before-write: 'delivering' gravado, write no PTY ainda não aconteceu;
//     - after-write: o write aconteceu e o claude gravou a mensagem no transcript
//       ($TRANSCRIPT), mas a fila ainda não removeu o item;
//     - delivered: entrega completa (item removido).
//   hibernate <dbPath> <scan> <ptyId> <first> <more>
//     O /exit da hibernação sai pela fila; com ele escrito e a PTY ainda viva, o
//     input do usuário chega cru (<first>, depois acumulado com <more> pelo
//     replaceText, como o hibernator faz). Avisa 'held' e trava para o SIGKILL.
//   boot <dbPath> <scan> <newPtyId> <ccSessionId>
//     restore() + onSessionLive(newPty): imprime o snapshot do boot e as escritas.
import { appendFileSync, writeSync } from 'node:fs'
import { openAppDb } from '../db'
import { PromptQueue } from '../prompt-queue'
import { createPromptQueueStore, deliveryInTranscript } from '../prompt-queue-store'
import type { LiveStatus, ScreenScan } from '../../../../shared/tui/attention-reason'
import type { PromptQueueSnapshot } from '../../../../shared/types/send-prompt'

const [mode, dbPath, scanJson, ...rest] = process.argv.slice(2)
const db = openAppDb(dbPath)
const scan = JSON.parse(scanJson) as ScreenScan
const say = (line: string) => writeSync(1, `${line}\n`)
// Trava o event loop: nada mais da fila roda até o SIGKILL.
const hang = (): never => {
  for (;;) {
    /* espera o SIGKILL */
  }
}

let status: LiveStatus = 'idle'
let hibernating = false
let onWrite: (id: string, text: string) => void = () => {}
const writes: string[] = []
let last: PromptQueueSnapshot | null = null

const queue = new PromptQueue({
  isRunning: () => true,
  status: () => status,
  screen: async () => scan,
  nativeStatus: () => true,
  handoffAsking: () => false,
  write: (id, text, raw) => {
    writes.push(`${id}:${raw ? 'raw:' : ''}${text}`)
    onWrite(id, text)
  },
  isHibernating: () => hibernating,
  beforeWrite: (_id, text) => {
    if (hibernating) return false
    if (text === '/exit') hibernating = true
    return true
  },
  emit: (s) => (last = s),
  warn: () => {},
  store: createPromptQueueStore(() => db),
  deliveryInTranscript,
})

async function enqueue(ptyId: string, text: string, stage: string): Promise<void> {
  if (stage === 'queued') status = 'working'
  if (stage === 'before-write') {
    onWrite = () => {
      say('before-write')
      hang()
    }
  }
  if (stage === 'after-write') {
    onWrite = (_id, written) => {
      const cc = process.env.CC_SESSION_ID as string
      // Linha no formato que o claude 2.1.29x grava ao receber o prompt.
      appendFileSync(
        process.env.TRANSCRIPT as string,
        `${JSON.stringify({
          parentUuid: 'p-2',
          isSidechain: false,
          promptId: 'prompt-2',
          type: 'user',
          message: { role: 'user', content: written },
          uuid: 'u-2',
          timestamp: new Date().toISOString(),
          userType: 'external',
          entrypoint: 'cli',
          cwd: '/tmp',
          sessionId: cc,
          version: '2.1.296',
          gitBranch: 'HEAD',
        })}\n`,
      )
      say('after-write')
      hang()
    }
  }
  const res = await queue.send({ sessionId: ptyId, text, when: 'on-idle' })
  if (stage === 'queued' && res.ok && !res.delivered) say('queued')
  if (stage === 'delivered' && res.ok && res.delivered) say('delivered')
  setInterval(() => {}, 1 << 30)
}

async function hibernate(ptyId: string, first: string, more: string): Promise<void> {
  const exit = await queue.send({
    sessionId: ptyId,
    text: '/exit',
    when: 'on-idle',
    ephemeral: true,
  })
  if (!exit.ok || !exit.delivered) throw new Error(`/exit não saiu: ${JSON.stringify(exit)}`)
  const held = await queue.send({ sessionId: ptyId, text: first, when: 'on-idle', raw: true })
  if (!held.ok || held.delivered) throw new Error(`input não ficou retido: ${JSON.stringify(held)}`)
  queue.replaceText(held.queued.id, first + more)
  say('held')
  hang()
}

async function boot(newPty: string, cc: string): Promise<void> {
  queue.restore()
  const restored = last
  queue.onSessionLive(newPty, cc)
  queue.onTurnEnded(newPty)
  await new Promise((r) => setTimeout(r, 800))
  say(JSON.stringify({ restored, after: last, writes }))
  queue.dispose()
  db.close()
}

if (mode === 'enqueue') void enqueue(rest[0], rest[1], rest[2])
else if (mode === 'hibernate') void hibernate(rest[0], rest[1], rest[2])
else void boot(rest[0], rest[1])
