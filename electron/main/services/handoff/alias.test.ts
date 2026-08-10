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

  it('cai no sufixo numérico só quando o pool inteiro está ocupado', () => {
    const taken = ['mauricio-auth-refactor', 'rafael-auth-refactor', 'gustavo-auth-refactor']
    expect(buildHandoffAlias({ role: 'implementer', task: 'Auth refactor', taken })).toBe(
      'mauricio-auth-refactor-2',
    )
    expect(
      buildHandoffAlias({
        role: 'implementer',
        task: 'Auth refactor',
        taken: [...taken, 'mauricio-auth-refactor-2'],
      }),
    ).toBe('mauricio-auth-refactor-3')
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

  it('escopos diferentes NÃO colidem (o mesmo nome se repete)', () => {
    const taken = ['mauricio-auth-refactor']
    expect(buildHandoffAlias({ role: 'implementer', task: 'Billing webhook', taken })).toBe(
      'mauricio-billing-webhook',
    )
  })
})
