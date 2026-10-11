import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// O rascunho do Composer (texto + imagem anexada) não passa pelo PTY: a sessão
// pode hibernar com ele na caixa. O id da sessão muda no exit (dormant:<cc>) e no
// wake (id novo); o rascunho vai junto com a pane e reaparece no Composer novo.
// Caminho real: digitar e colar no Composer → sessions:hibernated → pty:exit →
// clique (wakeDormantPane) → Composer da sessão nova.

const repo = { id: 'r1', label: 'infra', path: '/tmp/infra' }
const IMAGE_PATH = '/tmp/pitwall-images/img-sess-a-1.png'

let hibernatedHandler:
  ((e: { sessionId: string; ccSessionId: string; paneId: string | null }) => void) | null = null
const exitHandlers = new Set<(e: { sessionId: string; exitCode: number | null }) => void>()

const sessionsImpl: Record<string, (...args: never[]) => unknown> = {
  listLiveGlobal: () => Promise.resolve([]),
  resume: (input: { ccSessionId: string }) =>
    Promise.resolve({ session: liveSession('sess-new', input.ccSessionId), reattached: false }),
  saveImage: () => Promise.resolve(IMAGE_PATH),
  dormantSync: (list: unknown[]) => Promise.resolve(list),
  onHibernated: (h: typeof hibernatedHandler) => {
    hibernatedHandler = h
    return () => {
      hibernatedHandler = null
    }
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
              // O grafo de sessões fica no vazio inicial (alvos do @alias não importam aqui).
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
const { drafts, attachmentsBySession } = await import('./composer-drafts')
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

function renderComposer(sessionId: string) {
  return render(<Composer sessionId={sessionId} onSend={() => {}} onInsert={() => {}} />)
}

const textbox = () => screen.getByRole('textbox') as HTMLTextAreaElement

beforeEach(async () => {
  drafts.clear()
  attachmentsBySession.clear()
  useAppStore.setState({
    panes: [
      {
        paneId: 'pane-a',
        session: liveSession('sess-a', 'cc-a'),
        repo: repo as ActivePane['repo'],
        projectName: 'Infra',
        projectIcon: null,
        projectColor: null,
        mode: 'terminal',
      },
    ],
    restoreComplete: true,
    lazyRestore: true,
  })
  await useAppStore.getState().startLiveWatch()
})

afterEach(() => {
  cleanup()
  useAppStore.getState().stopLiveWatch()
  exitHandlers.clear()
})

describe('rascunho do Composer na hibernação', () => {
  it('texto + imagem colada → hiberna → wake → o rascunho volta no Composer da sessão nova', async () => {
    const first = renderComposer('sess-a')
    fireEvent.change(textbox(), { target: { value: 'revisa o deploy' } })
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
    const draft = textbox().value
    expect(draft).toContain('revisa o deploy')
    expect(draft).toContain(IMAGE_PATH)

    // O main hibernou a sessão; a aba vira dormant (o Terminal sai de cena).
    act(() => hibernatedHandler!({ sessionId: 'sess-a', ccSessionId: 'cc-a', paneId: 'pane-a' }))
    for (const h of exitHandlers) h({ sessionId: 'sess-a', exitCode: 0 })
    first.unmount()
    const dormant = useAppStore.getState().panes[0]
    expect(dormant.dormant).toBe(true)
    expect(dormant.composerDraft).toEqual({
      text: draft,
      attachments: [{ name: 'print.png', path: IMAGE_PATH }],
    })

    const woke = await useAppStore.getState().wakeDormantPane('pane-a')
    expect(woke).toBe('sess-new')
    const pane = useAppStore.getState().panes[0]
    expect(pane.composerDraft).toBeUndefined()

    renderComposer('sess-new')
    expect(textbox().value).toBe(draft)
    expect(screen.getByText('print.png')).toBeTruthy()
  })

  it('sem rascunho: a pane dormant não carrega nada e o Composer novo nasce vazio', async () => {
    const first = renderComposer('sess-a')
    act(() => hibernatedHandler!({ sessionId: 'sess-a', ccSessionId: 'cc-a', paneId: 'pane-a' }))
    first.unmount()
    expect(useAppStore.getState().panes[0].composerDraft).toBeUndefined()
    await useAppStore.getState().wakeDormantPane('pane-a')
    renderComposer('sess-new')
    expect(textbox().value).toBe('')
  })
})
