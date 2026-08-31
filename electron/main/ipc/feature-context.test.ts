/** @vitest-environment node */
// Unit do builder puro do contexto de feature injetado no spawn
// (--append-system-prompt-file). O contrato desta fase: o bloco APONTA (pulso,
// índice do ledger, endereço do arquivo do loop) em vez de despejar o doc — e
// tem teto de tamanho verificado, porque o modo de falha desta função é inchar
// de novo sem ninguém perceber.
import { describe, expect, it } from 'vitest'

import { buildFeatureContextContent, type FeatureLoopContext } from './feature-context'
import type { Feature } from '../../../shared/types/ipc'

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'feat-abc-123',
    projectId: 'proj-1',
    slug: 'minha-feature',
    title: 'Minha Feature',
    status: 'in-progress',
    objective: 'Entregar a coisa',
    docPath: '/tmp/feat.md',
    synthMode: 'auto',
    model: null,
    repos: [{ repoId: 'r1', branch: 'feat/x', worktreePath: '/repos/app' }],
    origin: 'manual',
    objectiveLinkCount: 0,
    isAppDev: false,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    archivedAt: null,
    body: '',
    ...overrides,
  }
}

const DAY = 24 * 60 * 60 * 1000

function makeLoop(overrides: Partial<FeatureLoopContext> = {}): FeatureLoopContext {
  return {
    liveness: 'alive',
    pulse: { body: 'Migration aplicada; falta ligar a UI do ledger.' },
    ledger: [
      { title: 'Migration 042 aplicada', createdAt: 3 * DAY },
      { title: 'Store do loop', createdAt: 2 * DAY },
      { title: 'Chip de vitalidade', createdAt: 1 * DAY },
    ],
    ...overrides,
  }
}

describe('buildFeatureContextContent', () => {
  it('inclui o header da feature e o bloco tracking com o featureId real', () => {
    const content = buildFeatureContextContent(makeFeature())
    expect(content).toContain('Esta sessão trabalha na feature «Minha Feature».')
    expect(content).toContain('NÃO edite o doc manualmente')
    expect(content).toContain('Status atual: in-progress')
    expect(content).toContain('Objetivo: Entregar a coisa')
    expect(content).toContain(
      `Tracking: this session's feature id is feat-abc-123. ` +
        'Link auto-created tasks to it (parentType "feature") and update its status via ' +
        'feature_update when you finish or get blocked.',
    )
  })

  it('omite a linha de objetivo quando null e mantém o tracking', () => {
    const content = buildFeatureContextContent(makeFeature({ objective: null }))
    expect(content).not.toContain('Objetivo:')
    expect(content).toContain("Tracking: this session's feature id is feat-abc-123.")
  })

  it('com loop: liveness, pulso INTEIRO e índice do ledger (data + título, sem corpo)', () => {
    const content = buildFeatureContextContent(makeFeature(), [], makeLoop())
    expect(content).toContain('Status atual: in-progress · vitalidade: alive')
    expect(content).toContain('Pulso vigente: Migration aplicada; falta ligar a UI do ledger.')
    expect(content).toContain('Últimas mudanças registradas:')
    expect(content).toContain('1970-01-04 · Migration 042 aplicada')
    expect(content).toContain('1970-01-02 · Chip de vitalidade')
  })

  it('leva no máximo 3 entradas do ledger, as mais recentes (ordem que o store devolve)', () => {
    const loop = makeLoop({
      ledger: [
        { title: 'quarta mais recente', createdAt: 4 * DAY },
        { title: 'terceira', createdAt: 3 * DAY },
        { title: 'segunda', createdAt: 2 * DAY },
        { title: 'ANTIGA DEMAIS', createdAt: 1 * DAY },
      ],
    })
    const content = buildFeatureContextContent(makeFeature(), [], loop)
    expect(content).not.toContain('ANTIGA DEMAIS')
    expect(content.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3)
  })

  it('aponta pro arquivo do loop no worktree do repo vinculado, com a instrução de leitura', () => {
    const content = buildFeatureContextContent(makeFeature(), [], makeLoop())
    expect(content).toContain('/repos/app/.pitwall/loop-minha-feature.md')
    expect(content).toContain('leia antes de mudar qualquer coisa aqui')
    expect(content).toContain('não edite o loop de features irmãs')
  })

  it('sem repo vinculado o ponteiro fica relativo (a sessão resolve pelo cwd)', () => {
    const content = buildFeatureContextContent(makeFeature({ repos: [] }), [], makeLoop())
    expect(content).toContain('Loop desta frente no disco: .pitwall/loop-minha-feature.md')
  })

  it('sem pulso o bloco continua coerente: sem a linha, com liveness e ledger', () => {
    const content = buildFeatureContextContent(makeFeature(), [], makeLoop({ pulse: null, liveness: 'quiet' }))
    expect(content).not.toContain('Pulso vigente')
    expect(content).toContain('vitalidade: quiet')
    expect(content).toContain('Últimas mudanças registradas:')
    expect(content).toContain("Tracking: this session's feature id is feat-abc-123.")
  })

  it('sem loop nenhum (feature recém-criada / snapshot indisponível) o bloco continua coerente', () => {
    const content = buildFeatureContextContent(makeFeature())
    expect(content).not.toContain('Pulso vigente')
    expect(content).not.toContain('vitalidade')
    expect(content).not.toContain('Últimas mudanças registradas')
    expect(content).toContain('.pitwall/loop-minha-feature.md')
    expect(content).toContain("Tracking: this session's feature id is feat-abc-123.")
  })

  it('NÃO despeja o corpo do doc — o bloco aponta pro material, não o carrega', () => {
    const body = '## Visão geral\n\nDetalhe importante da feature.\n\n## Estado atual\n\nOutro parágrafo.\n'
    const content = buildFeatureContextContent(makeFeature({ body }), [], makeLoop())
    expect(content).not.toContain('Detalhe importante da feature.')
    expect(content).not.toContain('## Visão geral')
  })

  it('sem OKR linkado (default []): avisa e sugere feature_set_objective_links', () => {
    const content = buildFeatureContextContent(makeFeature())
    expect(content).toContain('ainda não está sob nenhum OKR')
    expect(content).toContain('feature_set_objective_links')
  })

  it('com 1 OKR linkado: menciona o título no singular', () => {
    const content = buildFeatureContextContent(makeFeature(), ['Lançar o MCP'])
    expect(content).toContain('Esta feature serve o OKR «Lançar o MCP».')
  })

  it('com 2+ OKRs linkados: menciona todos no plural', () => {
    const content = buildFeatureContextContent(makeFeature(), ['OKR A', 'OKR B'])
    expect(content).toContain('Esta feature serve os OKRs: «OKR A», «OKR B».')
  })
})

// Teto de tamanho. 2000 é o pior caso plausível medido abaixo (1878 chars)
// mais uma folga curta. Referência: a implementação anterior, que anexava as
// seções-chave do doc, media 1545 num doc MÉDIO — e crescia junto com o
// documento, sem teto nenhum. Se este teste falhar, o bloco voltou a inchar:
// reveja o que entrou nele em vez de subir o número.
const FEATURE_CONTEXT_MAX_CHARS = 2000

describe('buildFeatureContextContent — teto de tamanho', () => {
  it('pior caso plausível cabe no teto', () => {
    const feature = makeFeature({
      title: 'T'.repeat(120),
      objective: 'O'.repeat(400),
      slug: 'uma-feature-com-slug-bem-comprido-de-verdade',
      repos: [
        {
          repoId: 'r1',
          branch: 'feat/x',
          worktreePath: '/home/usuario/projetos/pessoal/claude-manager/.worktrees/feature-loop-selfclosing',
        },
      ],
    })
    const loop = makeLoop({
      // Pulso no limite do PULSE_MAX_LENGTH e títulos de ledger longos.
      pulse: { body: 'P'.repeat(200) },
      ledger: [
        { title: 'L'.repeat(200), createdAt: 3 * DAY },
        { title: 'M'.repeat(200), createdAt: 2 * DAY },
        { title: 'N'.repeat(200), createdAt: 1 * DAY },
      ],
    })
    const content = buildFeatureContextContent(feature, ['A'.repeat(80), 'B'.repeat(80)], loop)
    expect(content.length).toBeLessThanOrEqual(FEATURE_CONTEXT_MAX_CHARS)
  })

  it('caso típico fica bem abaixo do teto', () => {
    const content = buildFeatureContextContent(makeFeature(), ['Fechar o loop das frentes'], makeLoop())
    expect(content.length).toBeLessThan(1000)
  })
})
