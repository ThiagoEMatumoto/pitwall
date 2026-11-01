// Processo filho de workspace-state.process.test.ts: abre o app.db pelo caminho
// de produção (openAppDb: pragmas + migrations reais), grava pelos mesmos serviços
// dos IPCs workspace:save-panes e workspace:save-layout, avisa o pai e fica vivo
// até o SIGKILL.
//   <dbPath> <panesJson|-> [<layoutJson|->]   ('-' = não grava essa coluna)
// As gravações seguem a ordem dos argumentos: open_panes, depois dock_layout.
import { openAppDb } from '../db'
import { saveDockLayout, saveOpenPanes } from '../workspace-state'

const [dbPath, panes, layout = '-'] = process.argv.slice(2)
const db = openAppDb(dbPath)
if (panes !== '-') saveOpenPanes(db, JSON.parse(panes))
if (layout !== '-') saveDockLayout(db, layout)
process.stdout.write('saved\n')
setInterval(() => {}, 1 << 30)
