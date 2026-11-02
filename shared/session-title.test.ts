import { describe, expect, it } from 'vitest'
import { AUTO_TITLE_MAX_CHARS, normalizeAutoTitle, preferredSessionTitle } from './session-title'

describe('normalizeAutoTitle', () => {
  it('tira aspas, ponto final e espaços', () => {
    expect(normalizeAutoTitle('  "Corrige login no Safari."  \n')).toBe('Corrige login no Safari')
    expect(normalizeAutoTitle('«Migra checkout»')).toBe('Migra checkout')
    expect(normalizeAutoTitle('`Refatora o parser`!')).toBe('Refatora o parser')
  })

  it('usa só a 1ª linha não vazia e descarta prefixo "Título:"', () => {
    expect(normalizeAutoTitle('\nTítulo: Ajusta deploy\nOutra linha')).toBe('Ajusta deploy')
  })

  it('corta em AUTO_TITLE_MAX_CHARS sem quebrar palavra quando dá', () => {
    const out = normalizeAutoTitle(
      'Investiga vazamento de memória no worker de sincronização de repositórios',
    )!
    expect(out.length).toBeLessThanOrEqual(AUTO_TITLE_MAX_CHARS)
    expect(out).toBe('Investiga vazamento de memória no worker de')
  })

  it('vazio ou só pontuação vira null', () => {
    expect(normalizeAutoTitle('   ')).toBeNull()
    expect(normalizeAutoTitle('"".')).toBeNull()
  })
})

describe('preferredSessionTitle — rótulo de exibição', () => {
  it('rename manual vence o auto-título', () => {
    expect(preferredSessionTitle({ manualTitle: 'Meu nome', autoTitle: 'Corrige login' })).toBe(
      'Meu nome',
    )
  })

  it('sem manual, mãe mostra o auto-título', () => {
    expect(preferredSessionTitle({ manualTitle: null, autoTitle: 'Corrige login' })).toBe(
      'Corrige login',
    )
  })

  it('manual vazio conta como ausente (limpar o rename volta ao auto)', () => {
    expect(preferredSessionTitle({ manualTitle: '  ', autoTitle: 'Corrige login' })).toBe(
      'Corrige login',
    )
  })

  it('filha fica inalterada: o auto-título nunca vence o apelido', () => {
    expect(
      preferredSessionTitle({ manualTitle: null, autoTitle: 'Corrige login', isChild: true }),
    ).toBeNull()
    expect(
      preferredSessionTitle({ manualTitle: 'zeca-api', autoTitle: 'Corrige login', isChild: true }),
    ).toBe('zeca-api')
  })

  it('nada próprio → null (o chamador cai no comportamento atual)', () => {
    expect(preferredSessionTitle({ manualTitle: null, autoTitle: null })).toBeNull()
  })
})
