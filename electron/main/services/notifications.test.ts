import { beforeEach, describe, expect, it, vi } from 'vitest'

const setBadgeCount = vi.fn()
vi.mock('electron', () => ({
  app: { setBadgeCount: (n: number) => setBadgeCount(n) },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}))

let prefsRow: { value: string } | undefined
vi.mock('./db', () => ({
  getDb: () => ({ prepare: () => ({ get: () => prefsRow }) }),
}))

import { notify, setMainWindow } from './notifications'

function fakeWindow(focused: boolean) {
  const listeners = new Map<string, () => void>()
  const win = {
    focused,
    isFocused: () => win.focused,
    isDestroyed: () => false,
    flashFrame: vi.fn(),
    on: (event: string, fn: () => void) => listeners.set(event, fn),
    emit: (event: string) => listeners.get(event)?.(),
  }
  return win
}

function install(focused: boolean) {
  const win = fakeWindow(focused)
  setMainWindow(win as unknown as Electron.BrowserWindow)
  return win
}

describe('notify × atenção da janela', () => {
  beforeEach(() => {
    prefsRow = undefined
    setBadgeCount.mockReset()
  })

  it('sessão aguardando com a janela fora de foco: pisca e conta no badge', () => {
    const win = install(false)
    notify({ title: 'a aguardando você', body: '', ccSessionId: 'cc-a' })
    notify({ title: 'b aguardando você', body: '', ccSessionId: 'cc-b' })
    expect(win.flashFrame).toHaveBeenCalledWith(true)
    expect(setBadgeCount).toHaveBeenLastCalledWith(2)
  })

  it('focar a janela para o flash e zera o badge', () => {
    const win = install(false)
    notify({ title: 't', body: '', ccSessionId: 'cc-a' })
    win.focused = true
    win.emit('focus')
    expect(win.flashFrame).toHaveBeenLastCalledWith(false)
    expect(setBadgeCount).toHaveBeenLastCalledWith(0)
    win.focused = false
    notify({ title: 't', body: '', ccSessionId: 'cc-b' })
    expect(setBadgeCount).toHaveBeenLastCalledWith(1)
  })

  it('janela focada não pisca', () => {
    const win = install(true)
    notify({ title: 't', body: '', ccSessionId: 'cc-a' })
    expect(win.flashFrame).not.toHaveBeenCalled()
    expect(setBadgeCount).not.toHaveBeenCalled()
  })

  it('aviso sem sessão (uso alto, reunião) não pisca', () => {
    const win = install(false)
    notify({ title: 'Uso alto', body: '90%' })
    expect(win.flashFrame).not.toHaveBeenCalled()
  })

  it('notificações desligadas não piscam', () => {
    prefsRow = { value: JSON.stringify({ enabled: false }) }
    const win = install(false)
    notify({ title: 't', body: '', ccSessionId: 'cc-a' })
    expect(win.flashFrame).not.toHaveBeenCalled()
  })
})
