import Database from 'better-sqlite3'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// O pedido tipado na Room, montado pelos produtores reais: handoffStore.ask
// estruturado → handoff_requests → projectAttention (roomWorld). Só o IPC é mock.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}))
let testDb: Database.Database
vi.mock('../../../electron/main/services/db', () => ({ getDb: () => testDb }))
vi.mock('../../../electron/main/services/transcript-path', () => ({
  findTranscriptPath: () => null,
}))
vi.mock('../../../electron/main/services/session-activity', () => ({
  buildSessionsFileIndex: () => new Map(),
}))
vi.mock('../../../electron/main/services/live-session-states', () => ({
  liveSessionStates: () => new Map(),
}))
const answerRequest = vi.fn()
const dismissAttention = vi.fn()
const snoozeAttention = vi.fn()
const dismiss = vi.fn()

const special: Record<string, Record<string, unknown>> = {
  room: { get: (id: string) => Promise.resolve(roomSnapshot(id)) },
  handoffs: {
    list: () => Promise.resolve(store.list()),
    answerRequest,
    dismissAttention,
    snoozeAttention,
    dismiss,
  },
}
vi.stubGlobal(
  'window',
  Object.assign(window, {
    api: new Proxy(
      {},
      {
        get: (_t, ns: string) =>
          new Proxy(
            {},
            {
              get: (_n, m: string) =>
                special[ns]?.[m] ??
                (m.startsWith('on') ? () => () => {} : () => new Promise(() => {})),
            },
          ),
      },
    ),
  }),
)

const store = await import('../../../electron/main/services/handoff-store')
const requestStore = await import('../../../electron/main/services/handoff-requests')
const harness = await import('../../../electron/main/services/attention/attention-test-harness')
const { roomWorld } = await import('../../../electron/main/services/attention/room-world')
const { roomSnapshot } = await import('../../../electron/main/services/feature-room-service')
const { FeatureRoom } = await import('./FeatureRoom')
const { useFeatureRoomStore } = await import('./feature-room-store')
const { useSessionGraphStore } = await import('@/features/sessions/session-graph-store')
const { useAttentionListStore } = await import('@/store/attentionStore')
const { useHandoffsStore } = await import('@/store/handoffsStore')
const { useAppStore } = await import('@/store/appStore')

const F = 'F'

function child(repo: string, sid: string) {
  harness.seedSession(testDb, sid, { repoId: repo, featureId: F })
  const h = store.create({
    targetRepoId: repo,
    motherSessionId: 'M',
    featureId: F,
    task: `task ${sid}`,
    composedPrompt: 'p',
  })
  return store.markRunning(h.id, sid)
}

const DECISION = {
  kind: 'decision' as const,
  question: 'Qual fila usar?',
  options: [
    { key: 'A', label: 'Redis', detail: 'mais uma dependência' },
    { key: 'B', label: 'SQLite', detail: 'já está no app' },
  ],
  recommendation: 'B',
  costOfError: 'reescrever o worker; reversível',
}

async function mount() {
  const w = roomWorld(testDb, [
    { id: 'M', status: 'idle' },
    { id: 'A', status: 'working' },
  ])
  useSessionGraphStore.setState({ graph: w.graph })
  useHandoffsStore.setState({ handoffs: w.handoffs, loading: false })
  useAttentionListStore.setState({ items: w.attention })
  useAppStore.setState({ area: 'room', liveSessions: w.live })
  useFeatureRoomStore.setState({ featureId: F, timelineFilter: null, openId: null })
  render(<FeatureRoom />)
  await screen.findByTestId('room-needs-count')
  return w
}

const open = () => screen.getByTestId('room-queue-open')

describe('RequestBody — pedido tipado na Room', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    harness.applyAllMigrations(testDb)
    harness.seedRepos(testDb)
    harness.seedFeature(testDb, F)
    harness.seedSession(testDb, 'M', { repoId: 'r6', featureId: F })
    for (const fn of [answerRequest, dismissAttention, snoozeAttention, dismiss]) fn.mockReset()
  })
  afterEach(() => testDb.close())

  it('decisão: 2 radios, recomendada, custo; escolher B e Responder chama answerRequest', async () => {
    const { request } = store.ask(child('r1', 'A').id, DECISION)
    answerRequest.mockResolvedValue(undefined)
    await mount()
    const radios = within(open()).getAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    expect(radios[1]).toHaveTextContent('recomendada')
    expect(radios[0]).not.toHaveTextContent('recomendada')
    expect(within(open()).getByText('Custo do erro:')).toBeInTheDocument()
    expect(open()).toHaveTextContent('reescrever o worker; reversível')
    expect(within(open()).getByText('Decisão')).toBeInTheDocument()
    const primary = within(open()).getByRole('button', { name: 'Escolha uma opção' })
    expect(primary).toBeDisabled()
    fireEvent.click(radios[1])
    expect(radios[1]).toHaveAttribute('aria-checked', 'true')
    fireEvent.change(within(open()).getByRole('textbox', { name: 'Comentário' }), {
      target: { value: ' manter simples ' },
    })
    const reply = within(open()).getByRole('button', { name: 'Responder B' })
    await act(async () => void fireEvent.click(reply))
    expect(answerRequest).toHaveBeenCalledWith({
      requestId: request!.id,
      choice: 'B',
      text: 'manter simples',
    })
    expect(within(open()).queryByText(/só você resolve/)).toBeNull()
  })

  it('human_only escalado mostra "só você resolve" e "escalado pela mãe"', async () => {
    const h = child('r1', 'A')
    const { request } = store.ask(h.id, { ...DECISION, risk: 'deploy_infra_spend' })
    requestStore.escalateRequest(request!.id, 'M')
    await mount()
    expect(within(open()).getByText('só você resolve (human_only)')).toBeInTheDocument()
    expect(within(open()).getByText('escalado pela mãe')).toBeInTheDocument()
    expect(open()).toHaveTextContent('— só você resolve')
  })

  it('Dispensar e Adiar usam a triagem (attention_dismissals), nunca handoffs.dismiss', async () => {
    const { request } = store.ask(child('r1', 'A').id, DECISION)
    dismissAttention.mockResolvedValue(undefined)
    snoozeAttention.mockResolvedValue(undefined)
    await mount()
    await act(
      async () => void fireEvent.click(within(open()).getByRole('button', { name: 'Dispensar' })),
    )
    expect(dismissAttention).toHaveBeenCalledWith({
      dedupKey: `request:${request!.id}`,
      requestId: request!.id,
    })
    await act(
      async () => void fireEvent.click(within(open()).getByRole('button', { name: 'Adiar 1 h' })),
    )
    expect(snoozeAttention).toHaveBeenCalledWith(
      expect.objectContaining({ dedupKey: `request:${request!.id}`, requestId: request!.id }),
    )
    expect(snoozeAttention.mock.calls[0][0].until).toBeGreaterThan(Date.now() + 59 * 60_000)
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('pergunta sem opções: a resposta é o texto; Rejeitar manda reject com o comentário', async () => {
    const { request } = store.ask(child('r1', 'A').id, 'Pode renomear o módulo?')
    answerRequest.mockResolvedValue(undefined)
    await mount()
    expect(within(open()).queryAllByRole('radio')).toHaveLength(0)
    const reply = within(open()).getByRole('button', { name: 'Responder' })
    expect(reply).toBeDisabled()
    fireEvent.change(within(open()).getByRole('textbox', { name: 'Resposta' }), {
      target: { value: 'pode' },
    })
    await act(async () => void fireEvent.click(reply))
    expect(answerRequest).toHaveBeenLastCalledWith({ requestId: request!.id, text: 'pode' })
    await act(
      async () => void fireEvent.click(within(open()).getByRole('button', { name: 'Rejeitar' })),
    )
    expect(answerRequest).toHaveBeenLastCalledWith({
      requestId: request!.id,
      reject: true,
      text: 'pode',
    })
  })

  it('ação humana: Feito e Não consigo mandam choice done/blocked', async () => {
    const { request } = store.ask(child('r1', 'A').id, {
      kind: 'human_action',
      question: 'Gere o token no console',
      recommendation: 'use o escopo read-only',
    })
    answerRequest.mockResolvedValue(undefined)
    await mount()
    expect(within(open()).getByText('Ação sua')).toBeInTheDocument()
    expect(open()).toHaveTextContent('Recomendação: use o escopo read-only')
    await act(
      async () => void fireEvent.click(within(open()).getByRole('button', { name: 'Feito' })),
    )
    expect(answerRequest).toHaveBeenLastCalledWith({ requestId: request!.id, choice: 'done' })
    await act(
      async () => void fireEvent.click(within(open()).getByRole('button', { name: 'Não consigo' })),
    )
    expect(answerRequest).toHaveBeenLastCalledWith({ requestId: request!.id, choice: 'blocked' })
  })

  it('erro da resposta aparece em role=status e o item continua', async () => {
    store.ask(child('r1', 'A').id, { ...DECISION, risk: 'destructive_data' })
    answerRequest.mockRejectedValue(new Error('O pedido já está answered.'))
    await mount()
    fireEvent.click(within(open()).getAllByRole('radio')[0])
    await act(
      async () => void fireEvent.click(within(open()).getByRole('button', { name: 'Responder A' })),
    )
    expect(within(open()).getByRole('status')).toHaveTextContent('já está answered')
    expect(screen.getByTestId('room-queue-row')).toHaveAttribute('data-kind', 'request')
  })
})
