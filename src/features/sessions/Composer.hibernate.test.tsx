import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hibernação × rascunho do Composer, com os produtores reais: store, Composer,
// persister, app.db com as migrations de produção, o coordenador de flush do
// main e o sweep de imagens do exit. O window.api só transporta, como o IPC.
//
// O rascunho é 'pane:<paneId>' e a pane hibernada mantém o paneId: ele não migra,
// fica no app.db e volta no Composer da sessão acordada.
vi.mock('electron', () => ({ app: {} }))

const home = mkdtempSync(join(tmpdir(), 'cm-hib-draft-home-'))
process.env.HOME = home

const { openAppDb } = await import('../../../electron/main/services/db')
const draftsSvc = await import('../../../electron/main/services/composer-drafts')
const { createDraftFlushCoordinator } = await import('../../../electron/main/services/draft-flush')
const { sweepAfterDraftFlush, sweepImageTempsKeepingDrafts } =
  await import('../../../electron/main/services/image-temp-sweep')
const { buildImageFilename, isSessionImageTempFile } =
  await import('../../../electron/main/services/image-temp')
const { PaneConfirmer } = await import('../../../electron/main/services/hibernate/pane-confirm')
const { paneCheckRefusal } = await import('../../../shared/hibernate')

const dir = mkdtempSync(join(tmpdir(), 'cm-hib-draft-'))
const imageDir = join(dir, 'tmp')
const db: Database.Database = openAppDb(join(dir, 'app.db'))

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

const repo = { id: 'r1', label: 'infra', path: '/tmp/infra' }

// Coordenador REAL do main; a janela é o renderer deste teste.
const coordinator = createDraftFlushCoordinator()
let flushRequestHandler: ((requestId: string) => void) | null = null
coordinator.remember({
  id: 1,
  isDestroyed: () => false,
  send: (_channel, requestId) => flushRequestHandler?.(requestId),
})

let hibernatedHandler:
  ((e: { sessionId: string; ccSessionId: string; paneId: string | null }) => void) | null = null
const exitHandlers = new Set<(e: { sessionId: string; exitCode: number | null }) => void>()
const confirmer = new PaneConfirmer({
  request: (r) => {
    paneCheckHandler?.(r)
    return paneCheckHandler !== null
  },
})
let paneCheckHandler:
  ((r: { requestId: string; sessionId: string; ccSessionId: string }) => void) | null = null

const sessionsImpl: Record<string, (...args: never[]) => unknown> = {
  listLiveGlobal: () => Promise.resolve([]),
  resume: (input: { ccSessionId: string }) =>
    Promise.resolve({ session: liveSession(woke, input.ccSessionId), reattached: false }),
  // Mesmo nome que o main grava (img-<sessionId>-<uuid>.<ext>), em disco.
  saveImage: (sessionId: string, _bytes: ArrayBuffer, mime: string) => {
    const path = join(imageDir, buildImageFilename({ id: randomUUID(), mime, sessionId }))
    writeFileSync(path, new Uint8Array([137, 80, 78, 71]))
    return Promise.resolve(path)
  },
  dormantSync: (list: unknown[]) => Promise.resolve(list),
  getDraft: async (key: string) => draftsSvc.getComposerDraft(db, key),
  getDraftSync: (key: string) => draftsSvc.getComposerDraft(db, key),
  saveDraft: async (d: Parameters<typeof draftsSvc.saveComposerDraft>[1]) =>
    draftsSvc.saveComposerDraft(db, d),
  saveDraftSync: (d: Parameters<typeof draftsSvc.saveComposerDraft>[1]) =>
    draftsSvc.saveComposerDraft(db, d),
  clearDraft: async (key: string) => draftsSvc.clearComposerDraft(db, key),
  onDraftFlushRequest: (h: (requestId: string) => void) => {
    flushRequestHandler = h
    return () => {}
  },
  draftFlushDone: (requestId: string) => {
    coordinator.ack(requestId, 1)
    return Promise.resolve()
  },
  onHibernated: (h: typeof hibernatedHandler) => {
    hibernatedHandler = h
    return () => {
      hibernatedHandler = null
    }
  },
  onPaneCheckRequest: (h: typeof paneCheckHandler) => {
    paneCheckHandler = h
    return () => {
      paneCheckHandler = null
    }
  },
  paneCheckResult: (r: Parameters<typeof confirmer.onResult>[0]) => {
    confirmer.onResult(r)
    return Promise.resolve()
  },
  onExit: (h: (e: { sessionId: string; exitCode: number | null }) => void) => {
    exitHandlers.add(h)
    return () => exitHandlers.delete(h)
  },
}

Object.assign(window, {
  api: new Proxy(
    {},
    {
      get: (_t, ns) =>
        new Proxy(
          {},
          {
            get: (_t2, prop) => {
              const impl =
                ns === 'sessions' && typeof prop === 'string' ? sessionsImpl[prop] : undefined
              if (impl) return impl
              if (ns === 'sessionGraph' && prop === 'get') return () => new Promise(() => {})
              if (typeof prop === 'string' && prop.startsWith('on')) return () => () => {}
              return () => Promise.resolve()
            },
          },
        ),
    },
  ),
})
// jsdom não tem object URL; o Composer só o usa para o thumbnail.
Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: () => {} })

const { useAppStore } = await import('@/store/appStore')
const { Composer } = await import('./Composer')
const { noteActivePane } = await import('./pane-activity')
type ActivePane = import('@/store/appStore').ActivePane

function liveSession(id: string, cc: string): ActivePane['session'] {
  return {
    id,
    repoId: 'r1',
    ccSessionId: cc,
    title: 'deploy infra',
    titleSource: null,
    paneId: null,
    status: 'running',
    startedAt: 1,
    endedAt: null,
    provider: 'claude',
  }
}

function renderComposer(C: typeof Composer, sessionId: string) {
  return render(
    <C
      sessionId={sessionId}
      paneId={pane}
      ccSessionId={cc}
      onSend={() => {}}
      onInsert={() => {}}
    />,
  )
}

const textbox = () => screen.getByRole('textbox') as HTMLTextAreaElement

async function pasteImage(): Promise<string> {
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'print.png', { type: 'image/png' })
  // jsdom não implementa Blob.arrayBuffer; o Composer lê os bytes para o saveImage.
  Object.assign(image, { arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer })
  fireEvent.paste(textbox(), {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
      files: [],
    },
  })
  await waitFor(() => expect(screen.getByText('print.png')).toBeTruthy())
  const path = textbox()
    .value.split(/\s+/)
    .find((t) => t.startsWith(imageDir))
  expect(path).toBeDefined()
  return path as string
}

// O que o main faz no pty:exit (sessions.ts): flush dos rascunhos pelo
// coordenador, depois o sweep das imagens da sessão que poupa as referenciadas.
function exitSweep(sessionId: string): Promise<boolean> {
  return sweepAfterDraftFlush(
    () => coordinator.request(1000),
    () =>
      sweepImageTempsKeepingDrafts(
        () => db,
        imageDir,
        (name) => isSessionImageTempFile(name, sessionId),
      ),
  )
}

async function hibernateAndExit(sessionId: string): Promise<void> {
  act(() => hibernatedHandler!({ sessionId, ccSessionId: cc, paneId: pane }))
  for (const h of exitHandlers) h({ sessionId, exitCode: 0 })
  expect(await exitSweep(sessionId)).toBe(true)
}

async function paneCheck() {
  return confirmer.confirm(sess, cc)
}

// paneId novo por teste: a memória do Composer e o pane-activity são do módulo.
let paneSeq = 0
let pane = ''
let sess = ''
let cc = ''
let woke = ''

beforeEach(async () => {
  pane = `pane-${++paneSeq}`
  sess = `sess-${paneSeq}`
  cc = `cc-${paneSeq}`
  woke = `woke-${paneSeq}`
  rmSync(imageDir, { recursive: true, force: true })
  mkdirSync(imageDir, { recursive: true })
  db.prepare('DELETE FROM composer_drafts').run()
  useAppStore.setState({
    panes: [
      {
        paneId: pane,
        session: liveSession(sess, cc),
        repo: repo as ActivePane['repo'],
        projectName: 'Infra',
        projectIcon: null,
        projectColor: null,
        mode: 'terminal',
      },
    ],
    area: 'projects',
    restoreComplete: true,
    lazyRestore: true,
  })
  noteActivePane(null)
  await useAppStore.getState().startLiveWatch()
})

afterEach(() => {
  cleanup()
  useAppStore.getState().stopLiveWatch()
  exitHandlers.clear()
  vi.restoreAllMocks()
})

describe('rascunho do Composer na hibernação (persister real + app.db)', () => {
  it('texto + imagem → hiberna (sweep do exit) → wake → o rascunho volta no Composer acordado', async () => {
    const first = renderComposer(Composer, sess)
    fireEvent.change(textbox(), { target: { value: 'revisa o deploy' } })
    const image = await pasteImage()
    const draft = textbox().value
    // Imagem da mesma sessão que NÃO está no rascunho: o sweep do exit precisa
    // rodar de verdade e levá-la.
    const stray = join(
      imageDir,
      buildImageFilename({ id: 'x', mime: 'image/png', sessionId: sess }),
    )
    writeFileSync(stray, 'x')

    // Ainda dentro do debounce: quem leva o rascunho ao app.db é o flush que o
    // main pede antes do sweep, com o Composer ainda montado.
    await hibernateAndExit(sess)
    first.unmount()

    expect(existsSync(image)).toBe(true)
    expect(existsSync(stray)).toBe(false)
    expect(draftsSvc.getComposerDraft(db, `pane:${pane}`)).toMatchObject({
      text: draft,
      attachments: [{ name: 'print.png', path: image }],
    })
    const dormant = useAppStore.getState().panes[0]
    expect(dormant).toMatchObject({ paneId: pane, dormant: true, dormantReason: 'hibernated' })

    expect(await useAppStore.getState().wakeDormantPane(pane)).toBe(woke)
    renderComposer(Composer, woke)
    expect(textbox().value).toBe(draft)
    expect(screen.getByText('print.png')).toBeTruthy()
  })

  it('renderer recarregado (memória do Composer vazia): o acordado hidrata do app.db', async () => {
    const first = renderComposer(Composer, sess)
    fireEvent.change(textbox(), { target: { value: 'continua daqui' } })
    const image = await pasteImage()
    const draft = textbox().value
    await hibernateAndExit(sess)
    first.unmount()
    await useAppStore.getState().wakeDormantPane(pane)

    vi.resetModules()
    const fresh = await import('./Composer')
    renderComposer(fresh.Composer, woke)
    await waitFor(() => expect(textbox().value).toBe(draft))
    expect(screen.getByText('print.png')).toBeTruthy()
    expect(existsSync(image)).toBe(true)
  })

  it('sem rascunho: nada no app.db e o Composer acordado nasce vazio', async () => {
    const first = renderComposer(Composer, sess)
    await hibernateAndExit(sess)
    first.unmount()
    expect(draftsSvc.getComposerDraft(db, `pane:${pane}`)).toBeNull()
    await useAppStore.getState().wakeDormantPane(pane)
    renderComposer(Composer, woke)
    expect(textbox().value).toBe('')
  })
})

describe('pane-check: o renderer recusa a aba em uso (store + Composer reais)', () => {
  it('aba fora de foco com o Composer vazio → pode hibernar', async () => {
    renderComposer(Composer, sess)
    const check = await paneCheck()
    expect(check).toEqual({
      paneId: pane,
      focused: false,
      composerHasText: false,
      composerFocused: false,
    })
    expect(paneCheckRefusal(check)).toBeNull()
  })

  it('aba ativa numa janela com foco → pane-focused', async () => {
    renderComposer(Composer, sess)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    noteActivePane(pane)
    expect(paneCheckRefusal(await paneCheck())).toBe('pane-focused')
    // A mesma aba ativa com a janela sem foco, ou fora da área de projetos, não conta.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    expect(paneCheckRefusal(await paneCheck())).toBeNull()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    useAppStore.setState({ area: 'overview' })
    expect(paneCheckRefusal(await paneCheck())).toBeNull()
  })

  it('Composer com texto → composer-busy; esvaziado → libera', async () => {
    renderComposer(Composer, sess)
    fireEvent.change(textbox(), { target: { value: 'escrevendo um prompt longo' } })
    expect(await paneCheck()).toMatchObject({ composerHasText: true })
    expect(paneCheckRefusal(await paneCheck())).toBe('composer-busy')
    fireEvent.change(textbox(), { target: { value: '' } })
    expect(paneCheckRefusal(await paneCheck())).toBeNull()
  })

  it('Composer só com imagem anexada → composer-busy', async () => {
    renderComposer(Composer, sess)
    await pasteImage()
    fireEvent.change(textbox(), { target: { value: '' } })
    expect(paneCheckRefusal(await paneCheck())).toBe('composer-busy')
  })

  it('Composer com foco (vazio) → composer-busy; blur → libera', async () => {
    renderComposer(Composer, sess)
    fireEvent.focus(textbox())
    expect(await paneCheck()).toMatchObject({ composerFocused: true, composerHasText: false })
    expect(paneCheckRefusal(await paneCheck())).toBe('composer-busy')
    fireEvent.blur(textbox())
    expect(paneCheckRefusal(await paneCheck())).toBeNull()
  })
})
