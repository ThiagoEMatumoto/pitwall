import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRef, type ComponentProps, type RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposerDraft } from '../../../shared/types/composer-draft'

vi.mock('electron', () => ({ app: {} }))

const draftApi = vi.hoisted(() => ({
  getDraft: vi.fn(),
  getDraftSync: vi.fn(() => null),
  saveDraft: vi.fn(async () => {}),
  saveDraftSync: vi.fn(),
  writeDraft: vi.fn(),
  clearDraft: vi.fn(async () => {}),
  saveImage: vi.fn(async () => '/tmp/print.png'),
}))

vi.mock('@/lib/ipc', () => {
  const inert = new Proxy(
    {},
    {
      get: (_t, key: string) =>
        key.startsWith('on') ? () => () => {} : () => Promise.resolve(null),
    },
  )
  const sessionsApi = new Proxy(draftApi as Record<string, unknown>, {
    get: (target, key: string) => target[key] ?? (inert as Record<string, unknown>)[key],
  })
  return {
    ...Object.fromEntries(
      [
        'projectsApi',
        'chatApi',
        'shellApi',
        'appApi',
        'gpuApi',
        'dialogApi',
        'prefsApi',
        'secretsApi',
        'vaultApi',
        'fsApi',
        'repoApi',
        'workspaceApi',
        'ccConfigsApi',
        'ccPluginsApi',
        'ccSettingsApi',
        'updatesApi',
        'usageApi',
        'metricsApi',
        'featuresApi',
        'loopApi',
        'objectivesApi',
        'handoffsApi',
        'batonApi',
        'sessionGraphApi',
        'motherPinsApi',
        'attentionApi',
        'roomApi',
        'canvasApi',
        'sendToApi',
        'architectureApi',
        'tasksApi',
        'diagramsApi',
        'windowApi',
        'notificationsApi',
        'mcpApi',
        'syncApi',
        'voiceApi',
        'designApi',
      ].map((k) => [k, inert]),
    ),
    sessionsApi,
  }
})
vi.mock('@/features/quick-composer/quick-composer-store', () => ({ useSendTargets: () => [] }))

import { openAppDb } from '../../../electron/main/services/db'
import {
  getComposerDraft,
  saveComposerDraft,
} from '../../../electron/main/services/composer-drafts'
import { Composer, type ComposerHandle } from './Composer'
import { DRAFT_HYDRATE_LOCK_MS } from './composer-draft-persister'

// jsdom não tem object URL; o Composer só o usa para o thumbnail.
Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: () => {} })

const SAVED = 'rascunho salvo antes do reboot'

let dir: string
let db: Database.Database
let paneSeq = 0

// O rascunho que a leitura devolve é o que o serviço do main grava e lê no app.db.
function savedDraft(paneId: string, text: string): ComposerDraft {
  const key = `pane:${paneId}`
  saveComposerDraft(db, { key, ccSessionId: 'cc-1', paneId, text, attachments: [] })
  const draft = getComposerDraft(db, key)
  if (!draft) throw new Error('rascunho não gravado')
  return draft
}

// Leitura do rascunho presa até o teste liberar: a janela entre o mount e a hidratação.
function pendingRead() {
  let release: (draft: ComposerDraft | null) => void = () => {}
  draftApi.getDraft.mockImplementationOnce(
    () => new Promise<ComposerDraft | null>((resolve) => (release = resolve)),
  )
  return async (draft: ComposerDraft | null) => {
    await act(async () => release(draft))
  }
}

function mount(
  paneId: string,
  props: Partial<ComponentProps<typeof Composer>> = {},
  handle?: RefObject<ComposerHandle>,
) {
  render(
    <Composer
      ref={handle}
      sessionId={`s-${paneId}`}
      paneId={paneId}
      ccSessionId="cc-1"
      onSend={vi.fn(async () => {})}
      onInsert={vi.fn(async () => {})}
      {...props}
    />,
  )
  return screen.getByRole('textbox') as HTMLTextAreaElement
}

function pasteImage(box: HTMLTextAreaElement) {
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'print.png', { type: 'image/png' })
  // jsdom não implementa Blob.arrayBuffer; o Composer lê os bytes para o saveImage.
  Object.assign(image, { arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer })
  fireEvent.paste(box, {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
      files: [],
    },
  })
}

// Uma tecla como o navegador a aplica: entra na posição do cursor, que avança.
// Campo só-leitura não recebe a tecla (o fireEvent do jsdom gravaria mesmo assim).
function typeChar(box: HTMLTextAreaElement, ch: string) {
  if (box.readOnly) return
  const start = box.selectionStart
  const end = box.selectionEnd
  fireEvent.change(box, {
    target: { value: box.value.slice(0, start) + ch + box.value.slice(end) },
  })
  box.setSelectionRange(start + ch.length, start + ch.length)
}

function type(box: HTMLTextAreaElement, text: string) {
  for (const ch of text) typeChar(box, ch)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-composer-hydrate-'))
  db = openAppDb(join(dir, 'app.db'))
  draftApi.getDraft.mockReset()
  draftApi.writeDraft.mockClear()
  draftApi.saveImage.mockClear()
  paneSeq++
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Composer — digitar antes da hidratação do rascunho', () => {
  it('durante a leitura o campo não aceita tecla, avisa que não está pronto e mantém o foco', async () => {
    const paneId = `hydrate-${paneSeq}`
    const saved = savedDraft(paneId, SAVED)
    const release = pendingRead()
    const box = mount(paneId)
    box.focus()

    expect(box.readOnly).toBe(true)
    expect(box.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByText('Recuperando rascunho…')).toBeTruthy()
    type(box, 'abc')
    expect(box.value).toBe('')

    await release(saved)

    expect(box.readOnly).toBe(false)
    expect(box.getAttribute('aria-busy')).toBe('false')
    expect(screen.queryByText('Recuperando rascunho…')).toBeNull()
    expect(document.activeElement).toBe(box)
  })

  it('digitou e moveu o cursor durante a leitura: o salvo entra inteiro, sem juntar nem deslocar a tecla seguinte', async () => {
    const paneId = `hydrate-${paneSeq}`
    const saved = savedDraft(paneId, SAVED)
    const release = pendingRead()
    const box = mount(paneId)

    type(box, 'abc')
    box.setSelectionRange(1, 1)
    await release(saved)
    typeChar(box, 'X')

    expect(box.value).toBe(`${SAVED}X`)
    expect(screen.queryByText(/juntado/)).toBeNull()
    expect(draftApi.getDraftSync).not.toHaveBeenCalled()
  })

  it('depois da leitura a tecla entra onde o cursor está', async () => {
    const paneId = `hydrate-${paneSeq}`
    const saved = savedDraft(paneId, SAVED)
    const release = pendingRead()
    const box = mount(paneId)

    await release(saved)
    box.setSelectionRange(8, 8)
    type(box, ' já')

    expect(box.value).toBe('rascunho já salvo antes do reboot')
  })

  it('sem rascunho salvo: destrava vazio e aceita a digitação em ordem', async () => {
    const release = pendingRead()
    const box = mount(`hydrate-${paneSeq}`)

    await release(null)

    expect(box.readOnly).toBe(false)
    expect(screen.getByText('Escreva um prompt…')).toBeTruthy()
    type(box, 'ação já começou')
    expect(box.value).toBe('ação já começou')
  })

  it('leitura que falha destrava o campo', async () => {
    draftApi.getDraft.mockRejectedValueOnce(new Error('main fora do ar'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const box = mount(`hydrate-${paneSeq}`)

    await act(async () => {})
    errors.mockRestore()

    expect(box.readOnly).toBe(false)
  })

  it('leitura que não volta: o teto destrava e o que for digitado é juntado ao salvo quando ele chegar', async () => {
    vi.useFakeTimers()
    const paneId = `hydrate-${paneSeq}`
    const saved = savedDraft(paneId, SAVED)
    const release = pendingRead()
    const box = mount(paneId)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_HYDRATE_LOCK_MS - 1)
    })
    expect(box.readOnly).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(box.readOnly).toBe(false)

    type(box, 'digitado')
    await release(saved)

    expect(box.value).toBe(`${SAVED}\n\ndigitado`)
    expect(screen.getByText(/juntado/)).toBeTruthy()
  })

  it('remount com rascunho em memória não trava: não há leitura a esperar', async () => {
    const paneId = `hydrate-${paneSeq}`
    const release = pendingRead()
    const first = mount(paneId)
    await release(null)
    type(first, 'em memória')
    cleanup()

    const box = mount(paneId)

    expect(box.readOnly).toBe(false)
    expect(box.value).toBe('em memória')
    expect(draftApi.getDraft).toHaveBeenCalledTimes(1)
  })

  it('a leitura do app.db real destrava o campo bem antes do teto', async () => {
    const paneId = `hydrate-${paneSeq}`
    savedDraft(paneId, SAVED)
    draftApi.getDraft.mockImplementationOnce(async (key: string) => getComposerDraft(db, key))

    const box = mount(paneId)
    expect(box.readOnly).toBe(true)
    const locked = performance.now()
    await act(async () => {})
    const lockedMs = performance.now() - locked

    expect(box.readOnly).toBe(false)
    expect(box.value).toBe(SAVED)
    console.info(`[medida] campo só-leitura à espera do rascunho: ${lockedMs.toFixed(1)} ms`)
    expect(lockedMs).toBeLessThan(DRAFT_HYDRATE_LOCK_MS)
  })
})

describe('Composer — teclas de controle durante a hidratação', () => {
  it('Enter, Esc, Tab, setas e Ctrl+C durante a leitura não chegam ao PTY nem enviam', async () => {
    const paneId = `hydrate-${paneSeq}`
    const saved = savedDraft(paneId, SAVED)
    const release = pendingRead()
    const onForwardKey = vi.fn()
    const onSend = vi.fn(async () => {})
    const box = mount(paneId, { onForwardKey, onSend })

    for (const key of ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown']) {
      fireEvent.keyDown(box, { key })
    }
    fireEvent.keyDown(box, { key: 'c', ctrlKey: true })
    expect(onForwardKey).not.toHaveBeenCalled()

    await release(saved)
    fireEvent.keyDown(box, { key: 'Enter' })
    await act(async () => {})

    expect(onSend).toHaveBeenCalledWith(SAVED)
    expect(onForwardKey).not.toHaveBeenCalled()
  })

  it('sem rascunho salvo, o Enter volta a dirigir a TUI depois da leitura', async () => {
    const release = pendingRead()
    const onForwardKey = vi.fn()
    const box = mount(`hydrate-${paneSeq}`, { onForwardKey })

    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onForwardKey).not.toHaveBeenCalled()

    await release(null)
    fireEvent.keyDown(box, { key: 'Enter' })

    expect(onForwardKey).toHaveBeenCalledWith('\r')
  })

  it('Ctrl+↑ durante a leitura não troca o campo pelo histórico', async () => {
    // O histórico é da sessão: o envio numa pane aparece na outra pane dela.
    const sessionId = `s-hist-${paneSeq}`
    const releaseFirst = pendingRead()
    const first = mount(`hist-a-${paneSeq}`, { sessionId })
    await releaseFirst(null)
    type(first, 'prompt antigo')
    fireEvent.keyDown(first, { key: 'Enter' })
    await act(async () => {})
    expect(first.value).toBe('')
    cleanup()

    const paneId = `hist-b-${paneSeq}`
    const saved = savedDraft(paneId, SAVED)
    const release = pendingRead()
    const box = mount(paneId, { sessionId })
    fireEvent.keyDown(box, { key: 'ArrowUp', ctrlKey: true })
    expect(box.value).toBe('')

    await release(saved)

    expect(box.value).toBe(SAVED)
    expect(screen.queryByText(/juntado/)).toBeNull()
  })
})

describe('Composer — sem chave durável', () => {
  it('sem pane nem conversa não há leitura: o campo nasce pronto e o Enter dirige a TUI', () => {
    const onForwardKey = vi.fn()
    const box = mount(`hydrate-${paneSeq}`, { paneId: null, ccSessionId: null, onForwardKey })

    expect(box.readOnly).toBe(false)
    expect(screen.getByText('Escreva um prompt…')).toBeTruthy()
    fireEvent.keyDown(box, { key: 'Enter' })

    expect(onForwardKey).toHaveBeenCalledWith('\r')
    expect(draftApi.getDraft).not.toHaveBeenCalled()
  })
})

describe('Composer — remount de pane já lida', () => {
  it('pane lida e vazia: o remount não trava, não relê e não grava', async () => {
    const paneId = `hydrate-${paneSeq}`
    const release = pendingRead()
    mount(paneId)
    await release(null)
    cleanup()
    draftApi.writeDraft.mockClear()

    const box = mount(paneId)

    expect(box.readOnly).toBe(false)
    expect(screen.getByText('Escreva um prompt…')).toBeTruthy()
    expect(draftApi.getDraft).toHaveBeenCalledTimes(1)
    expect(draftApi.writeDraft).not.toHaveBeenCalled()
    type(box, 'na hora')
    expect(box.value).toBe('na hora')
    expect(draftApi.writeDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: `pane:${paneId}`, text: 'na hora' }),
    )
  })

  it('enviou e a pane remontou: o campo vazio aceita a tecla na hora', async () => {
    const paneId = `hydrate-${paneSeq}`
    const release = pendingRead()
    const first = mount(paneId)
    await release(null)
    type(first, 'prompt enviado')
    fireEvent.keyDown(first, { key: 'Enter' })
    await act(async () => {})
    expect(first.value).toBe('')
    cleanup()

    const box = mount(paneId)

    expect(box.readOnly).toBe(false)
    expect(draftApi.getDraft).toHaveBeenCalledTimes(1)
  })

  it('leitura que falhou não vale como lida: o remount relê e recupera o salvo', async () => {
    const paneId = `hydrate-${paneSeq}`
    savedDraft(paneId, SAVED)
    draftApi.getDraft.mockRejectedValueOnce(new Error('main fora do ar'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    mount(paneId)
    await act(async () => {})
    errors.mockRestore()
    cleanup()

    draftApi.getDraft.mockImplementationOnce(async (key: string) => getComposerDraft(db, key))
    const box = mount(paneId)
    expect(box.readOnly).toBe(true)
    await act(async () => {})

    expect(box.value).toBe(SAVED)
    expect(getComposerDraft(db, `pane:${paneId}`)?.text).toBe(SAVED)
  })

  it('desmontou antes da leitura voltar: o remount relê e recupera o salvo', async () => {
    const paneId = `hydrate-${paneSeq}`
    const saved = savedDraft(paneId, SAVED)
    const release = pendingRead()
    mount(paneId)
    cleanup()
    await release(saved)

    draftApi.getDraft.mockImplementationOnce(async (key: string) => getComposerDraft(db, key))
    const box = mount(paneId)
    expect(box.readOnly).toBe(true)
    await act(async () => {})

    expect(box.value).toBe(SAVED)
  })
})

describe('Composer — ditado e imagem durante a hidratação', () => {
  it('ditado que chega durante a leitura espera por ela e entra depois do salvo, sem junção', async () => {
    const paneId = `hydrate-${paneSeq}`
    const saved = savedDraft(paneId, SAVED)
    const release = pendingRead()
    const handle = createRef<ComposerHandle>()
    const box = mount(paneId, {}, handle)

    act(() => handle.current?.appendText('ditado'))
    expect(box.value).toBe('')

    await release(saved)

    expect(box.value).toBe(`${SAVED} ditado`)
    expect(screen.queryByText(/juntado/)).toBeNull()
  })

  it('imagem colada durante a leitura espera por ela e entra depois do salvo, sem junção', async () => {
    const paneId = `hydrate-${paneSeq}`
    const saved = savedDraft(paneId, SAVED)
    const release = pendingRead()
    const box = mount(paneId)

    pasteImage(box)
    await act(async () => {})
    expect(draftApi.saveImage).not.toHaveBeenCalled()
    expect(box.value).toBe('')

    await release(saved)
    await act(async () => {})

    expect(box.value).toBe(`${SAVED} /tmp/print.png `)
    expect(screen.getByText('print.png')).toBeTruthy()
    expect(screen.queryByText(/juntado/)).toBeNull()
  })

  it('ditado com a pane sem rascunho salvo entra assim que a leitura termina', async () => {
    const release = pendingRead()
    const handle = createRef<ComposerHandle>()
    const box = mount(`hydrate-${paneSeq}`, {}, handle)

    act(() => handle.current?.appendText('ditado'))
    await release(null)

    expect(box.value).toBe('ditado')
  })
})
