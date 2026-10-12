// Processo filho do teste de write-through (composer-drafts.process.test.ts): o
// persister REAL do renderer ligado ao coordenador REAL do main
// (draft-write-through) sobre o app.db aberto pelo caminho de produção. O
// transporte é uma chamada direta, no lugar do ipcRenderer.send. Digita N
// mudanças SEM flush (o debounce de 500ms fica pendente) e avisa:
//  - 'keys': uma mudança por tick, como teclas; avisa no mesmo tick da última;
//  - 'burst': as N no mesmo tick (coalescidas no main); avisa no tick seguinte.
// O pai manda SIGKILL ~300ms depois do aviso: passada a janela de coalescência
// (100ms), antes do debounce FULL (500ms).
import { openAppDb } from '../db'
import { getComposerDraft } from '../composer-drafts'
import { createDraftWriteThrough } from '../draft-write-through'
import { createDraftPersister } from '../../../../src/features/sessions/composer-draft-persister'

const [dbPath, mode, key, base, countArg] = process.argv.slice(2)
const count = Number(countArg)
const db = openAppDb(dbPath)
const main = createDraftWriteThrough(() => db)
const persister = createDraftPersister({
  key,
  ccSessionId: 'cc-proc',
  paneId: key.replace(/^pane:/, ''),
  api: {
    get: async (k) => getComposerDraft(db, k),
    getSync: (k) => getComposerDraft(db, k),
    save: async (d) => main.saveDurable(structuredClone(d)),
    saveSync: (d) => main.saveDurable(structuredClone(d)),
    writeThrough: (d) => main.write(structuredClone(d)),
    clear: async () => {},
  },
})

const nextTick = () => new Promise((r) => setImmediate(r))
const textAt = (i: number) => `${base} ${i}`

async function run() {
  await persister.hydrate(() => {})
  if (mode === 'keys') {
    for (let i = 1; i <= count; i++) {
      await nextTick()
      persister.update({ text: textAt(i), attachments: [] })
    }
  } else {
    for (let i = 1; i <= count; i++) persister.update({ text: textAt(i), attachments: [] })
    await nextTick()
  }
  process.stdout.write('ready\n')
  setInterval(() => {}, 1 << 30)
}

void run()
