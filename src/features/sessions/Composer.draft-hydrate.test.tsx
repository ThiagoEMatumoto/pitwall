import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { Composer } from './Composer'
import { DRAFT_HYDRATE_LOCK_MS } from './composer-draft-persister'

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

function mount(paneId: string) {
  render(
    <Composer
      sessionId={`s-${paneId}`}
      paneId={paneId}
      ccSessionId="cc-1"
      onSend={vi.fn(async () => {})}
      onInsert={vi.fn(async () => {})}
    />,
  )
  return screen.getByRole('textbox') as HTMLTextAreaElement
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
