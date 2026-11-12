import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDockview, type DockviewApi } from 'dockview'
import type { LiveSessionInfo, Session, SessionActivity } from '../../../shared/types/ipc'

// O TerminalHost de verdade, com a tela vinda do parser real do xterm (headless, o mesmo
// do espelho do main) e capturas brutas do claude. Só o que precisa de canvas ou de IPC
// é trocado: window.api inerte, filhos visuais e a visibilidade (IntersectionObserver).
const h = vi.hoisted(() => {
  const inert: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, key) =>
        typeof key === 'string' && key.startsWith('on')
          ? () => () => {}
          : () => Promise.resolve(null),
    },
  )
  const state = {
    dataHandler: null as ((data: string) => void) | null,
    activityListeners: new Set<(a: unknown) => void>(),
    backlog: Promise.resolve('') as Promise<string>,
    intersect: null as ((entries: { isIntersecting: boolean }[]) => void) | null,
    chatProps: null as { tuiMenu: { kind: string } | null; paused?: boolean } | null,
    chatRenders: [] as { kind: string | null; paused: boolean }[],
    term: null as import('@xterm/headless').Terminal | null,
    focusCalls: 0,
    session: {
      exited: false,
      exitCode: null,
      error: null,
      write: () => {},
      kill: () => {},
      resize: () => {},
      setDataHandler: (handler: ((data: string) => void) | null) => {
        state.dataHandler = handler
      },
    },
  }
  const sessions: Record<string, unknown> = {
    getBacklog: () => state.backlog,
    onActivity: (cb: (a: unknown) => void) => {
      state.activityListeners.add(cb)
      return () => state.activityListeners.delete(cb)
    },
  }
  const namespaces: Record<string, unknown> = {
    sessions: new Proxy(sessions, {
      get: (t, key: string) => (key in t ? t[key] : inert[key]),
    }),
    perf: { enabled: false, report: () => {} },
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(namespaces, {
    get: (t, key: string) => (key in t ? t[key] : inert),
  })
  globalThis.IntersectionObserver = class {
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
      state.intersect = cb
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { load: () => Promise.resolve([]), ready: Promise.resolve() },
  })
  // Addons do xterm: só o contrato que o TerminalHost usa.
  const addon = () =>
    class {
      activate() {}
      dispose() {}
      fit() {}
      findNext() {}
    }
  return Object.assign(state, { addon })
})

vi.mock('@xterm/xterm', async () => {
  const headless = (await import('@xterm/headless')).default as unknown as {
    Terminal: typeof import('@xterm/headless').Terminal
  }
  class Terminal extends headless.Terminal {
    constructor() {
      super({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 1000 })
      h.term = this
    }
    open() {}
    focus() {
      h.focusCalls++
    }
    refresh() {}
    registerLinkProvider() {
      return { dispose() {} }
    }
    attachCustomKeyEventHandler() {}
    onSelectionChange() {
      return { dispose() {} }
    }
    hasSelection() {
      return false
    }
    getSelection() {
      return ''
    }
  }
  return { Terminal }
})
vi.mock('@xterm/addon-fit', () => ({ FitAddon: h.addon() }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: h.addon() }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: h.addon() }))
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: h.addon() }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: h.addon() }))
vi.mock('./terminal-atlas', () => ({
  registerTerminal: () => () => {},
  clearSharedAtlas: () => {},
}))
vi.mock('./useSession', () => ({ useSession: () => h.session }))
vi.mock('./SessionHeader', () => ({ SessionHeader: () => null }))
vi.mock('./useSessionFeature', () => ({ useSessionFeature: () => null }))
vi.mock('./AgentHud', () => ({ AgentHud: () => null }))
vi.mock('./voice/SummaryChip', () => ({ SummaryChip: () => null }))
vi.mock('./Composer', async () => {
  const { forwardRef } = await import('react')
  return {
    Composer: forwardRef(function Composer(p: { toolbar?: React.ReactNode }) {
      return <>{p.toolbar}</>
    }),
  }
})
vi.mock('./ComposerToolbar', () => ({
  ComposerToolbar: (p: { currentMode: string | null }) => (
    <div data-testid="mode">{p.currentMode ?? 'sem modo'}</div>
  ),
}))
vi.mock('./chat/ChatView', async () => {
  const { forwardRef } = await import('react')
  return {
    ChatView: forwardRef(function ChatView(p: NonNullable<typeof h.chatProps>) {
      h.chatProps = p
      h.chatRenders.push({ kind: p.tuiMenu?.kind ?? null, paused: p.paused === true })
      return null
    }),
  }
})
vi.mock('./tui-menu-parser', async (importOriginal) => {
  const real = await importOriginal<typeof import('./tui-menu-parser')>()
  return { ...real, parseTuiMenuFull: vi.fn(real.parseTuiMenuFull) }
})
vi.mock('./tui-picker-parser', async (importOriginal) => {
  const real = await importOriginal<typeof import('./tui-picker-parser')>()
  return { ...real, parseTuiPicker: vi.fn(real.parseTuiPicker) }
})
vi.mock('../../../shared/tui/read-tail', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../shared/tui/read-tail')>()
  return { ...real, readBufferTail: vi.fn(real.readBufferTail) }
})

import { Terminal } from './Terminal'
import { parseTuiMenuFull } from './tui-menu-parser'
import { parseTuiPicker } from './tui-picker-parser'
import { readBufferTail } from '../../../shared/tui/read-tail'
import { useToastStore } from '@/features/notifications/toast-store'
import { adoptRelaunchedSession, holdPaneForRelaunch, useAppStore } from '@/store/appStore'

// Capturas brutas do claude real (node-pty), o mesmo shape que chega pelo pty:data.
const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../../shared/tui/__fixtures__', name), 'utf8')
const PERMISSION_PROMPT = fixture('claude-2.1.286-permission-bash.ansi')
const IDLE_ACCEPT_EDITS = fixture('claude-2.1.318-rewind-e2e-after-restore.ansi')
const TRUST_PROMPT = fixture('claude-2.1.286-trust-unnumbered.ansi')

const session = { id: 's1', repoId: 'r1', ccSessionId: 'cc1', provider: 'claude' } as Session

const settle = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
// Passa do debounce de 150 ms do parse da TUI.
const SETTLED_MS = 400

async function mount(panelVisibility?: React.ComponentProps<typeof Terminal>['panelVisibility']) {
  render(
    <Terminal
      session={session}
      repoLabel="web"
      repoPath="/tmp"
      projectName="p"
      mode="chat"
      panelVisibility={panelVisibility}
      onClose={() => {}}
    />,
  )
  await settle(0)
}

const setVisible = (visible: boolean) => act(() => h.intersect!([{ isIntersecting: visible }]))

function setStatus(status: SessionActivity['status']) {
  const activity: SessionActivity = {
    ccSessionId: 'cc1',
    status,
    name: null,
    title: null,
    lastText: null,
    lastActivityAt: 1,
    model: null,
  }
  act(() => h.activityListeners.forEach((cb) => cb(activity)))
}

async function ptyPrints(raw: string) {
  act(() => h.dataHandler!(raw))
  await settle(SETTLED_MS)
}

const parses = () =>
  vi.mocked(parseTuiMenuFull).mock.calls.length + vi.mocked(parseTuiPicker).mock.calls.length
const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title)

describe('Terminal com a pane oculta', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    h.backlog = Promise.resolve('')
    h.chatProps = null
    h.activityListeners.clear()
    useToastStore.setState({ toasts: [] })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('visível: o pedido de permissão vira card depois que a saída assenta', async () => {
    await mount()
    setStatus('waiting')

    await ptyPrints(PERMISSION_PROMPT)

    expect(h.chatProps?.tuiMenu?.kind).toBe('permission')
    expect(h.chatProps?.paused).toBe(false)
  })

  it('oculta: a saída da TUI não é parseada e o chat fica em pausa', async () => {
    await mount()
    setStatus('waiting')
    await setVisible(false)
    vi.mocked(parseTuiMenuFull).mockClear()
    vi.mocked(parseTuiPicker).mockClear()

    await ptyPrints(PERMISSION_PROMPT)

    expect(parses()).toBe(0)
    expect(h.chatProps?.tuiMenu).toBeNull()
    expect(h.chatProps?.paused).toBe(true)
  })

  it('oculta: a troca de status também não parseia', async () => {
    await mount()
    setStatus('idle')
    await setVisible(false)
    await ptyPrints(PERMISSION_PROMPT)
    vi.mocked(parseTuiMenuFull).mockClear()
    vi.mocked(parseTuiPicker).mockClear()

    setStatus('waiting')

    expect(parses()).toBe(0)
    expect(h.chatProps?.tuiMenu).toBeNull()
  })

  it('ao voltar, o que a TUI desenhou com a pane oculta aparece sem esperar outro byte', async () => {
    await mount()
    setStatus('waiting')
    await setVisible(false)
    await ptyPrints(PERMISSION_PROMPT)

    await setVisible(true)
    await settle(20)

    expect(h.chatProps?.tuiMenu?.kind).toBe('permission')
    expect(h.chatProps?.paused).toBe(false)
  })

  it('ao voltar com a saída ainda na fila do xterm, o card espera a fila e não o debounce', async () => {
    await mount()
    setStatus('waiting')
    await setVisible(false)

    act(() => h.dataHandler!(PERMISSION_PROMPT))
    await setVisible(true)
    await settle(20)

    expect(h.chatProps?.tuiMenu?.kind).toBe('permission')
  })

  it('ao voltar, o chat sai da pausa já com o menu de agora, sem repintar o de antes de ocultar', async () => {
    await mount()
    setStatus('waiting')
    await ptyPrints(PERMISSION_PROMPT)
    expect(h.chatProps?.tuiMenu?.kind).toBe('permission')
    await setVisible(false)
    await ptyPrints(TRUST_PROMPT)
    h.chatRenders.length = 0

    await setVisible(true)

    expect(h.chatRenders.length).toBeGreaterThan(0)
    expect(h.chatRenders.filter((r) => !r.paused).map((r) => r.kind)).not.toContain('permission')
    expect(h.chatProps).toMatchObject({ paused: false, tuiMenu: { kind: 'trust' } })
  })

  it('modo trocado pela CLI com a pane oculta: o aviso sai ao voltar, contra o modo visto antes de ocultar', async () => {
    await mount()
    expect(screen.getByTestId('mode').textContent).toBe('default')
    await setVisible(false)

    await ptyPrints(IDLE_ACCEPT_EDITS)

    expect(screen.getByTestId('mode').textContent).toBe('default')
    expect(toastTitles()).toEqual([])

    await setVisible(true)
    await settle(20)

    expect(screen.getByTestId('mode').textContent).toBe('acceptEdits')
    expect(toastTitles()).toEqual([expect.stringMatching(/^Modo alterado para /)])
  })

  it('voltar sem a CLI ter trocado de modo não avisa', async () => {
    await mount()
    await ptyPrints(IDLE_ACCEPT_EDITS)
    await setVisible(false)
    await ptyPrints(IDLE_ACCEPT_EDITS)

    await setVisible(true)
    await settle(20)

    expect(screen.getByTestId('mode').textContent).toBe('acceptEdits')
    expect(toastTitles()).toEqual([expect.stringMatching(/^Modo alterado para /)])
  })

  it('voltar antes do replay do backlog não lê a tela ainda vazia', async () => {
    let deliver: (backlog: string) => void = () => {}
    h.backlog = new Promise((resolve) => (deliver = resolve))
    await mount()
    await setVisible(false)
    vi.mocked(parseTuiMenuFull).mockClear()
    vi.mocked(parseTuiPicker).mockClear()

    await setVisible(true)
    await settle(20)

    expect(parses()).toBe(0)
    expect(screen.getByTestId('mode').textContent).toBe('sem modo')

    deliver('')
    await settle(0)
    expect(screen.getByTestId('mode').textContent).toBe('default')
  })

  it('uma passada lê cada janela do tail uma vez só, para o menu e o picker', async () => {
    await mount()
    setStatus('waiting')
    vi.mocked(readBufferTail).mockClear()

    await ptyPrints(PERMISSION_PROMPT)

    const windows = vi.mocked(readBufferTail).mock.calls.map(([, n]) => n)
    expect(windows.length).toBeGreaterThan(0)
    expect(windows).toEqual([...new Set(windows)])
  })
})

// A aba inativa de um grupo fica visibility:hidden, com caixa de layout: o
// IntersectionObserver segue dizendo "visível". Quem sabe é o painel do dockview; aqui o
// dockview é o de verdade, com duas abas no mesmo grupo, e o observer nunca avisa nada.
describe('Terminal em aba do dockview', () => {
  let dock: DockviewApi
  let host: HTMLElement

  function twoTabs() {
    const a = dock.addPanel({ id: 'a', component: 'pane' })
    const b = dock.addPanel({ id: 'b', component: 'pane' })
    return { a, b }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    h.backlog = Promise.resolve('')
    h.chatProps = null
    h.activityListeners.clear()
    useToastStore.setState({ toasts: [] })
    host = document.body.appendChild(document.createElement('div'))
    dock = createDockview(host, {
      defaultRenderer: 'always',
      createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
    })
  })
  afterEach(() => {
    cleanup()
    dock.dispose()
    host.remove()
    vi.useRealTimers()
  })

  it('duas abas no mesmo grupo: só a ativa é visível para o dockview', () => {
    const { a, b } = twoTabs()

    expect(a.group).toBe(b.group)
    expect([a.api.isVisible, b.api.isVisible]).toEqual([false, true])
  })

  it('outra aba do grupo passa à frente: a saída da TUI não é parseada e o chat pausa', async () => {
    const { a, b } = twoTabs()
    a.api.setActive()
    await mount(a.api)
    setStatus('waiting')
    expect(h.chatProps?.paused).toBe(false)

    act(() => b.api.setActive())
    vi.mocked(parseTuiMenuFull).mockClear()
    vi.mocked(parseTuiPicker).mockClear()
    await ptyPrints(PERMISSION_PROMPT)

    expect(parses()).toBe(0)
    expect(h.chatProps?.tuiMenu).toBeNull()
    expect(h.chatProps?.paused).toBe(true)
  })

  it('a aba volta à frente: o chat sai da pausa já com o menu de agora', async () => {
    const { a, b } = twoTabs()
    a.api.setActive()
    await mount(a.api)
    setStatus('waiting')
    await ptyPrints(PERMISSION_PROMPT)
    act(() => b.api.setActive())
    await ptyPrints(TRUST_PROMPT)
    expect(h.chatProps).toMatchObject({ paused: true, tuiMenu: { kind: 'permission' } })
    h.chatRenders.length = 0

    act(() => a.api.setActive())

    expect(h.chatRenders.filter((r) => !r.paused).map((r) => r.kind)).not.toContain('permission')
    expect(h.chatProps).toMatchObject({ paused: false, tuiMenu: { kind: 'trust' } })
  })

  it('montada como aba inativa: nasce em pausa e lê a tela quando vira a ativa', async () => {
    h.backlog = Promise.resolve(PERMISSION_PROMPT)
    const { a } = twoTabs()
    vi.mocked(parseTuiMenuFull).mockClear()
    vi.mocked(parseTuiPicker).mockClear()

    await mount(a.api)
    setStatus('waiting')
    await settle(SETTLED_MS)

    expect(parses()).toBe(0)
    expect(h.chatProps?.paused).toBe(true)

    act(() => a.api.setActive())
    await settle(20)

    expect(h.chatProps).toMatchObject({ paused: false, tuiMenu: { kind: 'permission' } })
  })

  it('aba ativa numa área oculta segue em pausa, e a área voltar não acorda a aba inativa', async () => {
    const { a, b } = twoTabs()
    a.api.setActive()
    await mount(a.api)
    setStatus('waiting')

    await setVisible(false)
    expect(h.chatProps?.paused).toBe(true)

    act(() => b.api.setActive())
    await setVisible(true)
    await ptyPrints(PERMISSION_PROMPT)
    expect(h.chatProps).toMatchObject({ paused: true, tuiMenu: null })

    act(() => a.api.setActive())
    await settle(20)
    expect(h.chatProps).toMatchObject({ paused: false, tuiMenu: { kind: 'permission' } })
  })
})

describe('Terminal: replay do backlog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    h.term = null
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const screenLines = () => {
    const buffer = h.term!.buffer.active
    return Array.from({ length: buffer.length }, (_, i) =>
      buffer.getLine(i)!.translateToString(true),
    ).filter((line) => line !== '')
  }

  it('backlog cortado, com live visto antes da resposta: a tela não repete e segue na ordem', async () => {
    let deliver: (backlog: string) => void = () => {}
    h.backlog = new Promise((resolve) => (deliver = resolve))
    await mount()
    const seen = ['linha 1\r\n', 'linha 2\r\n', 'linha 3\r\n']
    act(() => seen.forEach((chunk) => h.dataHandler!(chunk)))

    deliver(seen.join('').slice(-16))
    await settle(0)
    act(() => h.dataHandler!('linha 4\r\n'))
    await settle(20)

    expect(screenLines()).toEqual(['nha 2', 'linha 3', 'linha 4'])
  })
})

// O xterm toma o teclado ao montar, pra digitar na TUI sem clicar. Aba nascida em
// segundo plano (o usuário escreveu a uma filha sem aba) é a exceção: quem digita
// está em outra tela (cartão do mapa, Room, card da equipe).
describe('Terminal: foco ao montar', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    h.focusCalls = 0
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const terminal = (props: Partial<React.ComponentProps<typeof Terminal>>) => (
    <Terminal
      session={session}
      repoLabel="web"
      repoPath="/tmp"
      projectName="p"
      mode="terminal"
      onClose={() => {}}
      {...props}
    />
  )

  it('aba comum: o xterm toma o teclado', async () => {
    render(terminal({}))
    await settle(0)

    expect(h.focusCalls).toBe(1)
  })

  it('nascida em segundo plano: o teclado fica com quem digita', async () => {
    render(terminal({ background: true }))
    await settle(0)

    expect(h.focusCalls).toBe(0)
  })

  it('nascida em segundo plano: voltar ao modo terminal foca como em qualquer aba', async () => {
    const view = render(terminal({ background: true }))
    await settle(0)

    view.rerender(terminal({ background: true, mode: 'chat' }))
    view.rerender(terminal({ background: true, mode: 'terminal' }))

    expect(h.focusCalls).toBe(1)
  })

  // A pane sai do próprio store e dorme/acorda pelas transições dele (o relance do
  // "Tornar mãe" faz o mesmo spread da hibernação e acorda pelo mesmo adoptLiveSession).
  // O painel repete o TerminalPanel do AppShell: dormant não monta o Terminal.
  it('nascida em segundo plano: depois de dormir e acordar, o xterm toma o teclado', async () => {
    const live: LiveSessionInfo = {
      id: 's-bg',
      ccSessionId: 'cc-bg',
      name: null,
      title: null,
      status: 'working',
      repo: null,
      projectName: null,
      projectIcon: null,
      projectColor: null,
      lastActivityAt: null,
      lastText: null,
    }
    useAppStore.setState({ panes: [], liveSessions: [live] })
    await act(() => useAppStore.getState().focusOrOpenSession(live, { background: true }))
    function Panel() {
      const pane = useAppStore((s) => s.panes[0])
      if (pane.dormant) return null
      return terminal({ session: pane.session, paneId: pane.paneId, background: pane.background })
    }

    render(<Panel />)
    await settle(0)
    expect(h.focusCalls).toBe(0)
    expect(useAppStore.getState().panes[0]).not.toHaveProperty('background')

    act(() => holdPaneForRelaunch('s-bg', 'cc-bg'))
    act(() => adoptRelaunchedSession({ ...useAppStore.getState().panes[0].session, id: 's-bg-2' }))
    await settle(0)

    expect(h.focusCalls).toBe(1)
  })
})
