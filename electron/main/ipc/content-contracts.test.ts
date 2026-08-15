/** @vitest-environment node */
// Handlers finos: o que se prova aqui é a COSTURA, não a regra (regra tem teste
// no store e nos gates). Duas invariantes: toda mutação broadcasta, e gate que
// reprova NÃO vira exceção — o run 'failed' é o resultado que a UI mostra.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ContentContract,
  ContentContractVersion,
  ContentGateRun,
} from '../../../shared/types/ipc'

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, cb: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, cb)
    },
  },
}))

const broadcastCalls: unknown[][] = []
vi.mock('../services/notify', () => ({
  broadcast: (...args: unknown[]) => broadcastCalls.push(args),
}))

let contractBySlug: ContentContract | null = null
let versions: ContentContractVersion[] = []
const storeCalls: unknown[][] = []
vi.mock('../services/content-contract-store', () => ({
  list: (filter?: unknown) => {
    storeCalls.push(['list', filter])
    return []
  },
  get: (id: string) => {
    storeCalls.push(['get', id])
    return contractBySlug
  },
  getBySlug: (slug: string) => {
    storeCalls.push(['getBySlug', slug])
    return contractBySlug
  },
  create: (input: { slug: string }) => {
    storeCalls.push(['create', input])
    return { id: 'novo', slug: input.slug, version: 1 } as ContentContract
  },
  update: (input: { id: string }) => {
    storeCalls.push(['update', input])
    return { id: input.id, version: 2 } as ContentContract
  },
  listVersions: (contractId: string) => {
    storeCalls.push(['listVersions', contractId])
    return versions
  },
  listGateRuns: (filter?: unknown) => {
    storeCalls.push(['listGateRuns', filter])
    return []
  },
}))

let gateRun: ContentGateRun
vi.mock('../services/content-gate-run', () => ({
  runAndRecordGate: (input: unknown) => {
    storeCalls.push(['runAndRecordGate', input])
    return { run: gateRun, outcome: { passed: false, blocking: true, evidence: 'x', details: {} } }
  },
}))

import { registerContentContractsIpc } from './content-contracts'

describe('content contracts ipc', () => {
  beforeEach(() => {
    handlers.clear()
    broadcastCalls.length = 0
    storeCalls.length = 0
    contractBySlug = null
    versions = []
    gateRun = { id: 'run-1', status: 'failed' } as ContentGateRun
    registerContentContractsIpc()
  })

  it('upsert de slug inédito cria e broadcasta', async () => {
    const handler = handlers.get('contentContracts:upsert')!
    const contract = (await handler(null, {
      slug: 'inss',
      title: 'T',
      outputLabel: 'roteiro',
      summary: 's',
      reason: 'r',
    })) as ContentContract

    expect(contract.id).toBe('novo')
    expect(storeCalls.map((c) => c[0])).toEqual(['getBySlug', 'create'])
    expect(broadcastCalls).toEqual([['contentContract:updated', contract]])
  })

  it('upsert de slug existente emenda pelo id e broadcasta', async () => {
    contractBySlug = { id: 'c1', slug: 'inss', version: 1 } as ContentContract
    const handler = handlers.get('contentContracts:upsert')!
    const contract = (await handler(null, { slug: 'inss', summary: 's', reason: 'r' })) as ContentContract

    expect(contract.version).toBe(2)
    expect(storeCalls.map((c) => c[0])).toEqual(['getBySlug', 'update'])
    expect(broadcastCalls).toEqual([['contentContract:updated', contract]])
  })

  it('run-gate com gate bloqueante resolve com o run failed (sem exceção) e broadcasta', async () => {
    const handler = handlers.get('contentContracts:run-gate')!
    const run = (await handler(null, {
      contractId: 'c1',
      gate: 'forbidden-facts',
      material: 'texto',
    })) as ContentGateRun

    expect(run.status).toBe('failed')
    expect(broadcastCalls).toEqual([['contentGateRun:updated', run]])
  })

  it('list-versions devolve o changelog do contrato pelo id', async () => {
    versions = [
      { id: 'v2', contractId: 'c1', version: 2, summary: 'tirou promessa', reason: 'reprovou' },
      { id: 'v1', contractId: 'c1', version: 1, summary: 'versão inicial', reason: 'criação' },
    ] as ContentContractVersion[]

    const handler = handlers.get('contentContracts:list-versions')!
    const out = (await handler(null, 'c1')) as ContentContractVersion[]

    expect(out.map((v) => v.version)).toEqual([2, 1])
    expect(storeCalls).toEqual([['listVersions', 'c1']])
  })

  it('contrato sem emendas devolve só a v1', async () => {
    versions = [
      { id: 'v1', contractId: 'c9', version: 1, summary: 'versão inicial', reason: 'criação' },
    ] as ContentContractVersion[]

    const out = (await handlers.get('contentContracts:list-versions')!(
      null,
      'c9',
    )) as ContentContractVersion[]

    expect(out).toHaveLength(1)
    expect(out[0].version).toBe(1)
  })

  it('leituras não broadcastam', async () => {
    await handlers.get('contentContracts:list')!(null, { status: 'active' })
    await handlers.get('contentContracts:list-gate-runs')!(null, { contractId: 'c1' })
    await handlers.get('contentContracts:list-versions')!(null, 'c1')
    expect(broadcastCalls).toEqual([])
  })
})
