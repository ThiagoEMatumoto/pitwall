// Espião de uma chamada só num canal do ipcMain.handle. O window.api chega à
// janela congelado pelo contextBridge: de lá não dá para envolver a função que o
// renderer chama, então a leitura é feita no main, na porta por onde ela entra.
import type { ElectronApplication } from 'playwright'

export interface InvokeTap {
  // O que `probe` valia na janela que chamou, lido antes de o handler do app rodar.
  probed: unknown
  args: unknown[]
}

type MainApp = Pick<ElectronApplication, 'evaluate'>

// Na próxima chamada de `channel`, avalia `probe` (expressão JS; pode ser uma
// Promise) na janela que chamou e só então repassa a chamada ao handler do app.
// Até lá o invoke do renderer segue pendente. false = canal sem handler.
// As funções abaixo viajam como texto até o main: nada de fora delas existe lá,
// e uma função interna com nome ganharia o __name do tsx, que também não existe.
export function tapNextInvoke(app: MainApp, channel: string, probe: string): Promise<boolean> {
  return app.evaluate(
    ({ ipcMain }, { channel, probe }) => {
      const original = (
        ipcMain as unknown as { _invokeHandlers?: Map<string, Function> }
      )._invokeHandlers?.get(channel)
      if (!original) return false
      const store = globalThis as unknown as { __invokeTaps?: Record<string, unknown> }
      store.__invokeTaps = { ...store.__invokeTaps, [channel]: null }
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (e, ...rest) => original(e, ...rest))
        const probed: unknown = await event.sender.executeJavaScript(probe)
        store.__invokeTaps = { ...store.__invokeTaps, [channel]: { probed, args } }
        return original(event, ...args)
      })
      return true
    },
    { channel, probe },
  )
}

// Expressão para o `probe`: quantos elementos casam com `selector` no instante
// em que ela roda. Não espera por nenhum: com espera, o que aparecesse com a
// chamada já no main entraria na conta.
export const countNow = (selector: string): string =>
  `document.querySelectorAll(${JSON.stringify(selector)}).length`

// A chamada que o espião de `channel` viu, ou null se ela ainda não veio.
export function tappedInvoke(app: MainApp, channel: string): Promise<InvokeTap | null> {
  return app.evaluate(
    (_electron, channel) =>
      (globalThis as unknown as { __invokeTaps?: Record<string, InvokeTap | null> }).__invokeTaps?.[
        channel
      ] ?? null,
    channel,
  )
}
