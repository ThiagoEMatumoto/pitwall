// @vitest-environment node
import { execFileSync } from 'node:child_process'
import xtermHeadless from '@xterm/headless'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeHome, type FakeHome } from './fake-home'
import {
  compareTyped,
  loadChecks,
  loadOutputs,
  promptLines,
  submittedLines,
} from './typing-fidelity'

const { Terminal } = xtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

let fake: FakeHome | null = null
afterEach(() => {
  fake?.cleanup()
  fake = null
})

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

  it('tira a saída de carga do stub que caiu no meio do eco', () => {
    const screen = 'raw> uma fra[[carga 10 lorem ipsum]]se digitada[[carga 20 lorem ipsum]]raw> '
    expect(promptLines(screen)).toEqual(['uma frase digitada', ''])
    expect(loadOutputs(screen)).toBe(2)
    expect(loadOutputs('raw> sem carga')).toBe(0)
  })

  // Produtor e consumidor reais: o que o stub escreve sob carga, lido de um xterm
  // estreito (o eco quebra de linha e a carga cai no meio de uma palavra).
  it('lê do xterm as linhas digitadas no stub sob carga, com espaço antes e depois da carga', async () => {
    fake = createFakeHome()
    fake.setRawLoad(true)
    const typed = [
      'abcdefgh ijklmnopq rstu  vwxyz, de novo e de novo ate quebrar a linha',
      'À tarde a Ângela comeu pão de ló com açúcar; você vê a lingüiça e o avô',
    ]
    const out = execFileSync(fake.rawClaudePath, ['--session-id', 'cc-load'], {
      input: typed.map((line) => `${line}\r`).join(''),
      cwd: fake.root,
      encoding: 'utf8',
    })
    const term = new Terminal({ cols: 24, rows: 6, scrollback: 1000, allowProposedApi: true })
    await new Promise<void>((resolve) => term.write(out, resolve))
    const buffer = term.buffer.active
    let screen = ''
    for (let y = 0; y < buffer.length; y++) {
      screen += buffer.getLine(y)?.translateToString(true) ?? ''
    }

    expect(loadOutputs(screen)).toBe(14)
    expect(promptLines(screen)).toEqual([...typed, ''])
  })
})

describe('loadChecks', () => {
  it('composer: a carga só vale se o chat mostrou mensagem nova enquanto se digitava', () => {
    const seen = { transcriptLines: 25, screenOutputs: 0 }
    expect(loadChecks('composer', { ...seen, chatChanged: true })).toEqual([
      { ok: true, label: '25 linhas de transcript gravadas durante a digitação' },
      { ok: true, label: 'o chat mostrou mensagem nova durante a digitação' },
    ])
    expect(loadChecks('composer', { ...seen, chatChanged: false })[1]).toEqual({
      ok: false,
      label: 'o chat NÃO mostrou mensagem nova durante a digitação',
    })
  })

  it('xterm: a carga só vale se a saída do stub chegou à tela no meio do eco', () => {
    const seen = { transcriptLines: 25, chatChanged: false }
    expect(loadChecks('xterm', { ...seen, screenOutputs: 30 })).toEqual([
      { ok: true, label: '25 linhas de transcript gravadas durante a digitação' },
      { ok: true, label: '30 saídas do stub na tela, no meio do eco' },
    ])
    expect(loadChecks('xterm', { ...seen, screenOutputs: 0 })[1]).toMatchObject({ ok: false })
  })

  it('sem linha de transcript gravada, não houve carga em nenhuma superfície', () => {
    const seen = { transcriptLines: 0, chatChanged: true, screenOutputs: 30 }
    expect(loadChecks('composer', seen)[0]).toMatchObject({ ok: false })
    expect(loadChecks('xterm', seen)[0]).toMatchObject({ ok: false })
  })
})
