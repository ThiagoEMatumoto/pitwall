/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import type { Digest } from '../feature-digest'
import {
  ACTIVE_CHILDREN_HEADING,
  composeBatonPrompt,
  renderActiveChildrenSection,
  type BatonChild,
} from './compose-baton-prompt'

const digest: Digest = {
  userPrompts: ['faz o mapa'],
  assistantNotes: [],
  finalSummary: 'fiz metade',
  todos: [],
  filesTouched: [],
  toolRollup: {},
  bashCommands: [],
  gitBranch: 'feat/x',
  refs: [],
  userTurns: 1,
  editCount: 0,
} as unknown as Digest

const kids: BatonChild[] = [
  {
    handoffId: 'h1',
    alias: 'mauricio-mapa',
    task: 'Mapa por feature',
    status: 'running',
    lastProgress: 'rodando testes',
  },
  {
    handoffId: 'h2',
    alias: 'otavio-modal',
    task: 'Modal do terminal',
    status: 'needs_input',
    lastProgress: null,
  },
]

describe('renderActiveChildrenSection', () => {
  it('lista alias, tarefa, status e último progresso de cada filha, com a feature', () => {
    const s = renderActiveChildrenSection(kids, 'Mission Control v2')
    expect(s.startsWith(ACTIVE_CHILDREN_HEADING)).toBe(true)
    expect(s).toContain('Feature: Mission Control v2')
    expect(s).toContain('"mauricio-mapa"')
    expect(s).toContain('Mapa por feature')
    expect(s).toContain('último progresso: rodando testes')
    expect(s).toContain('"otavio-modal"')
    expect(s).toContain('needs_input')
    expect(s).toContain('2 filhas')
  })
})

describe('composeBatonPrompt', () => {
  it('sem filhas, não fala de mãe', () => {
    expect(composeBatonPrompt({ digest })).not.toContain(ACTIVE_CHILDREN_HEADING)
  })

  it('com filhas, leva a lista como contexto e pede pra não repeti-la', () => {
    const p = composeBatonPrompt({ digest, children: kids, featureTitle: 'MC v2' })
    expect(p).toContain(ACTIVE_CHILDREN_HEADING)
    expect(p).toContain('mauricio-mapa')
    expect(p).toMatch(/NÃO a repita/)
  })
})
