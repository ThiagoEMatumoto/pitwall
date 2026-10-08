import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TuiMenuWatch } from '../tui-menu-watch'
import type { ScreenScan } from '../../../../shared/tui/attention-reason'

// Telas REAIS do claude 2.1.286 passadas pelo mesmo espelho headless que o app usa
// em produção (TuiMenuWatch): o gate lê o ScreenScan que o produtor real devolve.
export const FIXTURES = join(__dirname, '..', '..', '..', '..', 'shared', 'tui', '__fixtures__')

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

class FakePty extends EventEmitter {
  write(): void {}
}

// O scan sai do TuiMenuWatch real com timers reais (o write do xterm headless é
// assíncrono); os testes rodam com timers falsos em cima desse shape.
export async function scanOf(raw: string): Promise<ScreenScan> {
  const pty = new FakePty()
  const watch = new TuiMenuWatch()
  watch.attach(pty)
  pty.emit('spawn', { sessionId: 'probe', cols: 80, rows: 24 })
  pty.emit('data', { sessionId: 'probe', data: raw })
  const scan = await watch.rescan('probe')
  pty.emit('exit', { sessionId: 'probe', exitCode: 0 })
  if (!scan) throw new Error('sem scan')
  return scan
}
