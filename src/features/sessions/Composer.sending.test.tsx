import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ipc', () => {
  const inert = new Proxy(
    {},
    {
      get: (_t, key: string) =>
        key.startsWith('on') ? () => () => {} : () => Promise.resolve(null),
    },
  )
  // vi.mock confere as chaves exportadas: lista explícita das apis do preload.
  return Object.fromEntries(
    ["projectsApi", "sessionsApi", "chatApi", "shellApi", "appApi", "gpuApi", "dialogApi", "prefsApi", "secretsApi", "vaultApi", "fsApi", "repoApi", "workspaceApi", "ccConfigsApi", "ccPluginsApi", "ccSettingsApi", "updatesApi", "usageApi", "metricsApi", "featuresApi", "loopApi", "objectivesApi", "handoffsApi", "batonApi", "sessionGraphApi", "motherPinsApi", "attentionApi", "roomApi", "agentBusApi", "canvasApi", "sendToApi", "architectureApi", "tasksApi", "diagramsApi", "windowApi", "notificationsApi", "mcpApi", "syncApi", "voiceApi", "designApi"].map((k) => [k, inert]),
  )
})
// Destinos de @menção vêm do grafo de sessões vivo; aqui não há outras sessões.
vi.mock('@/features/quick-composer/quick-composer-store', () => ({ useSendTargets: () => [] }))

import { Composer } from './Composer'

describe('Composer — estado de envio', () => {
  it('vazio não envia; durante o envio mostra "Enviando" e não duplica', async () => {
    let release!: () => void
    const onSend = vi.fn(() => new Promise<void>((r) => (release = r)))
    render(<Composer sessionId="s1" onSend={onSend} onInsert={vi.fn(async () => {})} />)

    const send = screen.getByRole('button', { name: /Enviar/ })
    expect(send).toBeDisabled()

    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'roda os testes' } })
    expect(send).toBeEnabled()

    act(() => fireEvent.click(send))
    expect(screen.getByRole('button', { name: /Enviando/ })).toHaveAttribute('aria-busy', 'true')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)

    await act(async () => release())
    expect(screen.getByRole('button', { name: /Enviar/ })).toBeDisabled()
    expect(box).toHaveValue('')
  })
})
