// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { compareTyped, promptLines, submittedLines } from './typing-fidelity'

describe('compareTyped', () => {
  it('texto igual: todos os caracteres na ordem, sem divergência', () => {
    expect(compareTyped('ação já', 'ação já')).toEqual({
      ok: true,
      matched: 7,
      expectedLength: 7,
      actualLength: 7,
      firstDivergence: null,
    })
  })

  it('espaço a mais: conta o que bateu antes e mostra o ponto, com contexto dos dois lados', () => {
    const result = compareTyped('uma frase digitada', 'uma fra se digitada')
    expect(result).toMatchObject({ ok: false, matched: 7, expectedLength: 18, actualLength: 19 })
    expect(result.firstDivergence).toEqual({
      index: 7,
      expected: 'ma frase digi',
      actual: 'ma fra se dig',
    })
  })

  it('letras fora de ordem divergem na primeira trocada', () => {
    expect(compareTyped('abcdef', 'abdcef')).toMatchObject({
      ok: false,
      matched: 2,
      firstDivergence: { index: 2 },
    })
  })

  it('texto cortado diverge no fim do que chegou', () => {
    expect(compareTyped('abcdef', 'abc')).toMatchObject({
      ok: false,
      matched: 3,
      actualLength: 3,
      firstDivergence: { index: 3, expected: 'abcdef', actual: 'abc' },
    })
  })
})

describe('submittedLines', () => {
  it('separa por Enter e tira os marcadores do bracketed-paste; a última é a linha aberta', () => {
    expect(submittedLines('\x1b[200~olá, ação\x1b[201~\rab  c\rres')).toEqual([
      'olá, ação',
      'ab  c',
      'res',
    ])
    expect(submittedLines('')).toEqual([''])
  })
})

describe('promptLines', () => {
  it('uma entrada por prompt do stub, sem o que veio antes do primeiro', () => {
    expect(promptLines('banner do stubraw> primeiraraw> segunda  raw> ')).toEqual([
      'primeira',
      'segunda  ',
      '',
    ])
    expect(promptLines('ainda sem prompt')).toEqual([])
  })
})
