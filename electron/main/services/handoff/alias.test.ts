/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { buildHandoffAlias, kebab, roleForHandoffMode, scopeSlug } from './alias'

describe('kebab', () => {
  it('remove acentos, espaços e parênteses (o `to` do SendMessage é string crua)', () => {
    expect(kebab('Refatoração do Auth (v2)')).toBe('refatoracao-do-auth-v2')
    expect(kebab('MIGRAÇÃO João & Cia.')).toBe('migracao-joao-cia')
  })

  it('não deixa hífen nas bordas nem repetido', () => {
    expect(kebab('  --- olá,  mundo!! ---  ')).toBe('ola-mundo')
  })

  it('string sem caractere aproveitável vira vazia', () => {
    expect(kebab('!!! ??? ...')).toBe('')
  })
})

describe('scopeSlug', () => {
  it('descarta stopwords e limita a 3 palavras', () => {
    expect(scopeSlug('Adicionar endpoint de health-check no serviço')).toBe(
      'adicionar-endpoint-health',
    )
  })

  it('cabe em 28 chars sem terminar em hífen', () => {
    const slug = scopeSlug('Implementar sincronização completa de credenciais externas')
    expect(slug.length).toBeLessThanOrEqual(28)
    expect(slug.endsWith('-')).toBe(false)
  })

  it('cai em "task" quando não sobra nada aproveitável', () => {
    expect(scopeSlug('!!!')).toBe('task')
    expect(scopeSlug('   ')).toBe('task')
  })

  it('usa as stopwords quando a task SÓ tem stopwords (não devolve vazio)', () => {
    expect(scopeSlug('de a o')).toBe('de-a-o')
  })
})

describe('roleForHandoffMode', () => {
  it('mapeia o modo do handoff para o papel', () => {
    expect(roleForHandoffMode('plan')).toBe('investigator')
    expect(roleForHandoffMode('auto-edits')).toBe('implementer')
    expect(roleForHandoffMode('interactive')).toBe('operator')
    expect(roleForHandoffMode(undefined)).toBe('investigator')
  })
})

describe('buildHandoffAlias', () => {
  it('monta <nome>-<escopo> com nome estável por papel', () => {
    expect(buildHandoffAlias({ role: 'implementer', task: 'Auth refactor' })).toBe(
      'mauricio-auth-refactor',
    )
    expect(buildHandoffAlias({ role: 'investigator', task: 'Auth refactor' })).toBe(
      'otavio-auth-refactor',
    )
  })

  it('é kebab estrito mesmo com acento/espaço/parêntese na task', () => {
    const alias = buildHandoffAlias({ role: 'implementer', task: 'Migração de sessões (peer)' })
    expect(alias).toBe('mauricio-migracao-sessoes-peer')
    expect(alias).toMatch(/^[a-z0-9-]+$/)
  })

  it('anda no pool do papel antes de usar número', () => {
    expect(
      buildHandoffAlias({
        role: 'implementer',
        task: 'Auth refactor',
        taken: ['mauricio-auth-refactor'],
      }),
    ).toBe('rafael-auth-refactor')

    expect(
      buildHandoffAlias({
        role: 'implementer',
        task: 'Auth refactor',
        taken: ['mauricio-auth-refactor', 'rafael-auth-refactor'],
      }),
    ).toBe('gustavo-auth-refactor')
  })

  it('empresta nome de outro papel quando o pool do papel esgota', () => {
    const taken = ['mauricio-auth-refactor', 'rafael-outra-coisa', 'gustavo-mais-uma']
    expect(buildHandoffAlias({ role: 'implementer', task: 'Auth refactor', taken })).toBe(
      'otavio-auth-refactor',
    )
  })

  it('cai no sufixo numérico só quando o roster inteiro está ocupado', () => {
    // Roster de 9 nomes ocupado por completo: só aí entra o sufixo numérico.
    const taken = [
      'mauricio-a',
      'rafael-b',
      'gustavo-c',
      'otavio-d',
      'marina-e',
      'caio-f',
      'renata-g',
      'joaquim-h',
      'lia-i',
    ]
    expect(buildHandoffAlias({ role: 'implementer', task: 'Auth refactor', taken })).toBe(
      'mauricio-auth-refactor-2',
    )
  })

  it('compara o ocupado ignorando caixa e espaços em volta', () => {
    expect(
      buildHandoffAlias({
        role: 'implementer',
        task: 'Auth refactor',
        taken: ['  Mauricio-Auth-Refactor '],
      }),
    ).toBe('rafael-auth-refactor')
  })

  it('o nome é único entre as sessões vivas, mesmo com escopos diferentes', () => {
    // A razão de ser do alias: "manda pro Maurício" tem que resolver UMA sessão.
    // Se o nome se repetisse por escopo, voltaríamos a depender do sufixo.
    const taken = ['mauricio-auth-refactor']
    expect(buildHandoffAlias({ role: 'implementer', task: 'Billing webhook', taken })).toBe(
      'rafael-billing-webhook',
    )
  })

  it('não reserva nome para alias no formato antigo (handoff: repo)', () => {
    expect(
      buildHandoffAlias({
        role: 'implementer',
        task: 'Auth refactor',
        taken: ['handoff: legal-app'],
      }),
    ).toBe('mauricio-auth-refactor')
  })
})
