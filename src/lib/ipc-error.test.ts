import { describe, expect, it } from 'vitest'
import { ipcErrorMessage } from './ipc-error'

describe('ipcErrorMessage', () => {
  it('tira o prefixo do ipcRenderer.invoke e fica com o motivo', () => {
    const err = new Error(
      "Error invoking remote method 'sessions:resume': Error: conversa aberta em outro processo",
    )

    expect(ipcErrorMessage(err)).toBe('conversa aberta em outro processo')
  })

  it('erro com classe própria no main: o nome da classe sai junto', () => {
    const err = new Error(
      "Error invoking remote method 'handoffs:send-message': ChildWriteRefusedError: Não deu para entregar: há um menu aberto.",
    )

    expect(ipcErrorMessage(err)).toBe('Não deu para entregar: há um menu aberto.')
  })

  it('o que não veio do IPC fica como está', () => {
    expect(ipcErrorMessage(new Error('disco cheio'))).toBe('disco cheio')
    expect(ipcErrorMessage('sem conexão')).toBe('sem conexão')
  })
})
