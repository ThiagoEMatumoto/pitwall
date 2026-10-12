// Processo filho do teste de durabilidade (composer-drafts.process.test.ts):
// abre o app.db pelo caminho de produção (openAppDb: pragmas + migrations
// reais), grava o rascunho pelo mesmo serviço do IPC sessions:save-draft,
// avisa o pai e fica vivo até levar SIGKILL.
import { openAppDb } from '../db'
import { saveComposerDraft } from '../composer-drafts'

const [dbPath, payload] = process.argv.slice(2)
const db = openAppDb(dbPath)
saveComposerDraft(db, JSON.parse(payload))
process.stdout.write('saved\n')
setInterval(() => {}, 1 << 30)
