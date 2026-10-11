// Processo filho de workspace-state.process.test.ts: abre o app.db pelo caminho
// de produção (openAppDb: pragmas + migrations reais), grava o open_panes pelo
// mesmo serviço do IPC workspace:save-panes, avisa o pai e fica vivo até o SIGKILL.
import { openAppDb } from '../db'
import { saveOpenPanes } from '../workspace-state'

const [dbPath, payload] = process.argv.slice(2)
const db = openAppDb(dbPath)
saveOpenPanes(db, JSON.parse(payload))
process.stdout.write('saved\n')
setInterval(() => {}, 1 << 30)
