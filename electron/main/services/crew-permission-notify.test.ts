import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  crew: true,
  focused: null as string | null,
  prefs: { enabled: true, sessionWaiting: true },
  title: 'mauricio-auth' as string | null,
}))
const notify = vi.hoisted(() => vi.fn())

vi.mock('./db', () => ({
  getDb: () => ({
    prepare: () => ({ get: () => ({ cc_session_id: 'cc-1', title: state.title }) }),
  }),
}))
vi.mock('./handoff-store', () => ({ isActiveCrewChild: () => state.crew }))
vi.mock('./notifications', () => ({
  getNotifPrefs: () => state.prefs,
  getMainWindow: () => ({ isFocused: () => state.focused != null }),
  getRendererFocusedSession: () => state.focused,
  notify,
}))

import { notifyCrewPermission, resetCrewPermissionNotifyForTests } from './crew-permission-notify'
import { TuiMenuWatch } from './tui-menu-watch'

const FIXTURES = join(__dirname, '..', '..', '..', 'shared', 'tui', '__fixtures__')
const PERMISSION = readFileSync(join(FIXTURES, 'claude-2.1.286-permission-bash.ansi'), 'utf8')
const IDLE_PROMPT = readFileSync(join(FIXTURES, 'claude-2.1.286-idle-prompt.ansi'), 'utf8')
const CLEAR = '\x1b[2J\x1b[3J\x1b[H'

class FakePty extends EventEmitter {
  write(): void {}
}

// Espelho real alimentado pela captura do 2.1.286: o menu vem do produtor.
async function watchShowing(...screens: string[]) {
  const pty = new FakePty()
  const watch = new TuiMenuWatch()
  watch.attach(pty)
  pty.emit('spawn', { sessionId: 's1', cols: 80, rows: 24 })
  const show = async (raw: string) => {
    pty.emit('data', { sessionId: 's1', data: CLEAR + raw })
    await watch.rescan('s1')
    notifyCrewPermission('s1', watch)
  }
  for (const s of screens) await show(s)
  return { watch, show }
}

describe('notifyCrewPermission', () => {
  beforeEach(() => {
    resetCrewPermissionNotifyForTests()
    notify.mockReset()
    Object.assign(state, { crew: true, focused: null, title: 'mauricio-auth' })
    state.prefs = { enabled: true, sessionWaiting: true }
  })

  it('filha ativa com menu de permissão: avisa com alias e comando resumido', async () => {
    await watchShowing(PERMISSION)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({
      title: 'mauricio-auth pede permissão: Bash: touch permissao-fixture.txt',
      ccSessionId: 'cc-1',
    })
  })

  it('uma vez por aparição: re-scan do mesmo menu não repete; menu novo avisa de novo', async () => {
    const { watch, show } = await watchShowing(PERMISSION)
    notifyCrewPermission('s1', watch)
    expect(notify).toHaveBeenCalledTimes(1)
    await show(IDLE_PROMPT)
    await show(PERMISSION)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('não avisa: fim de turno, sessão fora do crew, olhando a filha ou prefs desligadas', async () => {
    await watchShowing(IDLE_PROMPT)
    state.crew = false
    await watchShowing(PERMISSION)
    resetCrewPermissionNotifyForTests()
    state.crew = true
    state.focused = 'cc-1'
    await watchShowing(PERMISSION)
    resetCrewPermissionNotifyForTests()
    state.focused = null
    state.prefs = { enabled: true, sessionWaiting: false }
    await watchShowing(PERMISSION)
    expect(notify).not.toHaveBeenCalled()
  })

  it('alias ausente cai em "Filha"', async () => {
    state.title = null
    await watchShowing(PERMISSION)
    expect(notify.mock.calls[0][0].title).toMatch(/^Filha pede permissão: /)
  })
})
