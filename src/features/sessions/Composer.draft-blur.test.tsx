import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const draftApi = vi.hoisted(() => ({
  getDraft: vi.fn(async () => null),
  getDraftSync: vi.fn(() => null),
  saveDraft: vi.fn(async () => {}),
  saveDraftSync: vi.fn(),
  writeDraft: vi.fn(),
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
  // vi.mock confere as chaves exportadas: lista explícita das apis do preload.
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
// Destinos de @menção vêm do grafo de sessões vivo; aqui não há outras sessões.
vi.mock('@/features/quick-composer/quick-composer-store', () => ({ useSendTargets: () => [] }))

import { Composer } from './Composer'

describe('Composer — rascunho no blur', () => {
  it('grava pelo canal assíncrono na hora, sem IPC síncrono', async () => {
    render(
      <Composer
        sessionId="s1"
        paneId="pane-blur"
        ccSessionId="cc-blur"
        onSend={vi.fn(async () => {})}
        onInsert={vi.fn(async () => {})}
      />,
    )
    // Hidratação (leitura do salvo) resolvida.
    await act(async () => {})
    expect(draftApi.getDraft).toHaveBeenCalledWith('pane:pane-blur')

    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'meio de uma frase' } })
    expect(draftApi.saveDraft).not.toHaveBeenCalled()

    fireEvent.blur(box)

    expect(draftApi.saveDraft).toHaveBeenCalledTimes(1)
    expect(draftApi.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'pane:pane-blur', text: 'meio de uma frase' }),
    )
    expect(draftApi.saveDraftSync).not.toHaveBeenCalled()
    expect(draftApi.getDraftSync).not.toHaveBeenCalled()
  })
})
