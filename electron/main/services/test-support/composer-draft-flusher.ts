// Processo filho do teste de flush síncrono (composer-drafts.process.test.ts):
// o persister REAL do renderer, ligado ao serviço do main sobre o app.db aberto
// pelo caminho de produção. Digita (o debounce de 500ms fica pendente) e:
//  - 'flush': chama flushSync, o ponto de flush do blur/quit, e avisa;
//  - 'no-flush': só avisa (controle: prova que o debounce ainda não gravou);
//  - 'flush-before-hydrate': digita antes da leitura do salvo terminar e dá
//    flushSync (o salvo é juntado, não sobrescrito).
// Em todos os modos o pai manda SIGKILL assim que lê o aviso.
import { openAppDb } from '../db'
import { clearComposerDraft, getComposerDraft, saveComposerDraft } from '../composer-drafts'
import { createDraftPersister } from '../../../../src/features/sessions/composer-draft-persister'

const [dbPath, mode, key, text] = process.argv.slice(2)
const db = openAppDb(dbPath)
const persister = createDraftPersister({
  key,
  ccSessionId: 'cc-proc',
  paneId: key.replace(/^pane:/, ''),
  api: {
    get: async (k) => getComposerDraft(db, k),
    getSync: (k) => getComposerDraft(db, k),
    save: async (d) => saveComposerDraft(db, d),
    saveSync: (d) => saveComposerDraft(db, d),
    clear: async (k) => clearComposerDraft(db, k),
  },
})

async function main() {
  const reading = persister.hydrate(() => {})
  if (mode !== 'flush-before-hydrate') await reading
  persister.update({ text, attachments: [{ name: 'shot.png', path: '/x/img-proc-1.png' }] })
  if (mode !== 'no-flush') persister.flushSync()
  process.stdout.write('ready\n')
  setInterval(() => {}, 1 << 30)
}

void main()
