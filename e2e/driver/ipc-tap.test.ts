import type { ElectronApplication } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { countNow, tapNextInvoke, tappedInvoke } from './ipc-tap'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const CHANNEL = 'sessions:send-prompt'

// O ipcMain do Electron no que o espião usa: um handler por canal (o segundo
// handle lança) e o mapa interno _invokeHandlers.
function fakeMain() {
  const handlers = new Map<string, Handler>()
  const ipcMain = {
    _invokeHandlers: handlers,
    handle: (channel: string, handler: Handler) => {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => void handlers.delete(channel),
  }
  // Como o Playwright: a função viaja como texto e roda no main, sem o escopo de
  // quem a escreveu.
  const evaluate = (fn: (...a: unknown[]) => unknown, arg: unknown) =>
    Promise.resolve(new Function(`return (${fn.toString()})`)()({ ipcMain }, arg))
  return { handlers, app: { evaluate } as unknown as Pick<ElectronApplication, 'evaluate'> }
}

// A janela que chamou: cada executeJavaScript entra na ordem e responde depois
// de uma volta do loop, como uma ida ao renderer.
function fakeSender(order: string[], answer: unknown) {
  return {
    sender: {
      executeJavaScript: (code: string) =>
        new Promise((resolve) => {
          order.push(`probe ${code}`)
          setTimeout(() => resolve(answer), 5)
        }),
    },
  }
}

afterEach(() => {
  delete (globalThis as { __invokeTaps?: unknown }).__invokeTaps
  document.body.replaceChildren()
})

// Como o executeJavaScript: a expressão roda no escopo global da janela.
const runInWindow = (code: string): unknown => (0, eval)(code)
const addTab = (): void => {
  const tab = document.createElement('div')
  tab.className = 'dv-tab'
  document.body.append(tab)
}
const TAB = '.dv-tab'
// A aba que só abre `ms` depois, como a de um reveal que ainda espera o main.
const addTabLater = (ms: number): Promise<void> =>
  new Promise((resolve) =>
    setTimeout(() => {
      addTab()
      resolve()
    }, ms),
  )
// A janela que chamou, de verdade: o probe roda no documento do teste.
const windowSender = () => ({
  sender: { executeJavaScript: async (code: string) => runInWindow(code) },
})

describe('countNow', () => {
  it('conta o que está na janela na hora da leitura', () => {
    expect(runInWindow(countNow(TAB))).toBe(0)

    addTab()
    addTab()

    expect(runInWindow(countNow(TAB))).toBe(2)
  })
})

describe('tapNextInvoke', () => {
  it('lê a janela antes de o handler do app rodar e repassa a chamada com o retorno dele', async () => {
    const { handlers, app } = fakeMain()
    const order: string[] = []
    handlers.set(CHANNEL, (_e, input) => {
      order.push('handler')
      return { ok: true, echoed: input }
    })

    expect(await tapNextInvoke(app, CHANNEL, 'abas()')).toBe(true)
    expect(await tappedInvoke(app, CHANNEL)).toBeNull()
    const payload = { sessionId: 'filha', text: 'oi', when: 'now' }
    const result = await handlers.get(CHANNEL)?.(fakeSender(order, 1), payload)

    expect(order).toEqual(['probe abas()', 'handler'])
    expect(result).toEqual({ ok: true, echoed: payload })
    expect(await tappedInvoke(app, CHANNEL)).toEqual({ probed: 1, args: [payload] })
  })

  it('sai sozinho na primeira chamada: a segunda vai direto ao handler do app', async () => {
    const { handlers, app } = fakeMain()
    const order: string[] = []
    handlers.set(CHANNEL, () => {
      order.push('handler')
      return 'ok'
    })

    await tapNextInvoke(app, CHANNEL, 'abas()')
    await handlers.get(CHANNEL)?.(fakeSender(order, 0), 'primeira')
    const second = await handlers.get(CHANNEL)?.(fakeSender(order, 1), 'segunda')

    expect(second).toBe('ok')
    expect(order).toEqual(['probe abas()', 'handler', 'handler'])
    expect(await tappedInvoke(app, CHANNEL)).toEqual({ probed: 0, args: ['primeira'] })
  })

  it('aba que abre com o envio já no main: fica fora da leitura', async () => {
    const { handlers, app } = fakeMain()
    handlers.set(CHANNEL, () => 'ok')
    await tapNextInvoke(app, CHANNEL, countNow(TAB))

    const opened = addTabLater(40)
    await handlers.get(CHANNEL)?.(windowSender(), 'recado')

    expect((await tappedInvoke(app, CHANNEL))?.probed).toBe(0)
    await opened
    expect(document.querySelectorAll(TAB)).toHaveLength(1)
  })

  it('aba aberta antes de o envio chegar ao main: entra na leitura', async () => {
    const { handlers, app } = fakeMain()
    handlers.set(CHANNEL, () => 'ok')
    await tapNextInvoke(app, CHANNEL, countNow(TAB))

    addTab()
    await handlers.get(CHANNEL)?.(windowSender(), 'recado')

    expect((await tappedInvoke(app, CHANNEL))?.probed).toBe(1)
  })

  it('canal sem handler: devolve false e não registra nenhum', async () => {
    const { handlers, app } = fakeMain()

    expect(await tapNextInvoke(app, CHANNEL, 'abas()')).toBe(false)
    expect(handlers.size).toBe(0)
    expect(await tappedInvoke(app, CHANNEL)).toBeNull()
  })
})
