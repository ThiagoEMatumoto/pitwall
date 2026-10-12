// Processo filho de prompt-queue.process.test.ts. Roda a PromptQueue real com o
// store real sobre o app.db aberto pelo caminho de produção (openAppDb). Só a PTY
// é falsa: write() registra, e a tela é a captura real que o pai passa em JSON.
//
//   enqueue <dbPath> <scan> <ptyId> <text> <stage>
//     stage = queued | before-write | written | after-write | delivered
//     Avisa o pai no estágio pedido e trava (o pai manda SIGKILL):
//     - queued: send() respondeu 'queued' (sessão trabalhando);
//     - before-write: 'delivering' gravado, write no PTY ainda não aconteceu;
//     - written: o write no PTY retornou e send() respondeu 'delivered', mas o
//       claude ainda não gravou nada no transcript (o kill o leva junto);
//     - after-write: o write aconteceu e o claude gravou a mensagem no transcript
//       ($TRANSCRIPT), mas a fila ainda não conferiu;
//     - delivered: o claude gravou a mensagem e a resposta, e a fila confirmou
//       pelo transcript e removeu a linha.
//   boot <dbPath> <scan> <newPtyId> <ccSessionId>
//     restore() + onSessionLive(newPty): imprime o snapshot do boot e as escritas.
//     A PTY nova age como o claude: grava a mensagem e a resposta no $TRANSCRIPT.
import { appendFileSync, writeSync } from 'node:fs'
import { openAppDb } from '../db'
import { PromptQueue } from '../prompt-queue'
import { createPromptQueueStore, deliveryProof } from '../prompt-queue-store'
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
let onWrite: (id: string, text: string) => void = () => {}
const writes: string[] = []
let last: PromptQueueSnapshot | null = null

const queue = new PromptQueue({
  isRunning: () => true,
  status: () => status,
  screen: async () => scan,
  nativeStatus: () => true,
  handoffAsking: () => false,
  write: (id, text) => {
    writes.push(`${id}:${text}`)
    onWrite(id, text)
  },
  emit: (s) => (last = s),
  warn: () => {},
  store: createPromptQueueStore(() => db),
  deliveryProof,
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
      appendTranscript(userLine(written))
      say('after-write')
      hang()
    }
  }
  if (stage === 'delivered') {
    onWrite = (_id, written) => appendTranscript(userLine(written) + assistantLine())
  }
  const res = await queue.send({ sessionId: ptyId, text, when: 'on-idle' })
  if (stage === 'queued' && res.ok && !res.delivered) say('queued')
  if (stage === 'written' && res.ok && res.delivered) say('written')
  if (stage === 'delivered' && res.ok && res.delivered) {
    // O fim do turno confere o transcript: a linha só sai com a resposta gravada.
    status = 'idle'
    queue.onTurnEnded(ptyId)
    const left = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM prompt_queue_items').get() as { n: number }).n
    const wait = setInterval(() => {
      if (left() > 0) return
      clearInterval(wait)
      say('delivered')
    }, 20)
  }
  setInterval(() => {}, 1 << 30)
}

const appendTranscript = (lines: string) => appendFileSync(process.env.TRANSCRIPT as string, lines)

// Linhas no formato que o claude 2.1.29x grava ao receber o prompt e ao responder.
const meta = () => ({
  isSidechain: false,
  timestamp: new Date().toISOString(),
  userType: 'external',
  entrypoint: 'cli',
  cwd: '/tmp',
  sessionId: process.env.CC_SESSION_ID as string,
  version: '2.1.296',
  gitBranch: 'HEAD',
})
const userLine = (written: string) =>
  `${JSON.stringify({
    parentUuid: 'p-2',
    promptId: 'prompt-2',
    type: 'user',
    message: { role: 'user', content: written },
    uuid: 'u-2',
    ...meta(),
  })}\n`
const assistantLine = () =>
  `${JSON.stringify({
    parentUuid: 'u-2',
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'rodando' }] },
    uuid: 'a-2',
    ...meta(),
  })}\n`

async function boot(newPty: string): Promise<void> {
  onWrite = (_id, written) => appendTranscript(userLine(written) + assistantLine())
  queue.restore()
  const restored = last
  queue.onSessionLive(newPty)
  queue.onTurnEnded(newPty)
  await new Promise((r) => setTimeout(r, 800))
  // Fim do turno da resposta: a fila confere o transcript e solta a linha.
  queue.onTurnEnded(newPty)
  say(JSON.stringify({ restored, after: last, writes }))
  queue.dispose()
  db.close()
}

if (mode === 'enqueue') void enqueue(rest[0], rest[1], rest[2])
else void boot(rest[0])
