import { describe, expect, it } from 'vitest'
import { lineDiff, previewLines, shortPath, summarizeTools, toolView } from './tool-view'

describe('toolView', () => {
  it('Read mostra o arquivo encurtado e a faixa de linhas', () => {
    const v = toolView('Read', {
      file_path: '/repo/src/features/chat/ChatView.tsx',
      offset: 10,
      limit: 50,
    })
    expect(v).toMatchObject({
      category: 'read',
      label: 'Leu',
      target: '…/chat/ChatView.tsx',
      meta: 'linhas 10–59',
    })
  })

  it('Bash usa a primeira linha do comando e guarda o comando inteiro', () => {
    const v = toolView('Bash', { command: 'cd x &&\nnpm test', description: 'Roda os testes' })
    expect(v).toMatchObject({
      category: 'bash',
      label: 'Rodou',
      target: 'cd x &&',
      meta: 'Roda os testes',
    })
    expect(v.command).toBe('cd x &&\nnpm test')
  })

  it('Edit vira diff de linhas com contagem', () => {
    const v = toolView('Edit', {
      file_path: '/a/b.ts',
      old_string: 'um\ndois\ntrês',
      new_string: 'um\nDOIS\ntrês',
    })
    expect(v.label).toBe('Editou')
    expect(v.meta).toBe('+1 −1')
    expect(v.diff?.map((l) => `${l.sign}${l.text}`)).toEqual([' um', '-dois', '+DOIS', ' três'])
  })

  it('Write numera as linhas e marca tudo como adição', () => {
    const v = toolView('Write', { file_path: '/a/novo.ts', content: 'a\nb\n' })
    expect(v.label).toBe('Escreveu')
    expect(v.diff).toEqual([
      { sign: '+', num: '1', text: 'a' },
      { sign: '+', num: '2', text: 'b' },
    ])
    expect(v.meta).toBe('+2')
  })

  it('MultiEdit separa os trechos com um marcador', () => {
    const v = toolView('MultiEdit', {
      file_path: '/a/b.ts',
      edits: [
        { old_string: 'x', new_string: 'y' },
        { old_string: 'p', new_string: 'q' },
      ],
    })
    expect(v.diff?.map((l) => `${l.sign}${l.text}`)).toEqual(['-x', '+y', ' ⋯', '-p', '+q'])
  })

  it('tool desconhecida cai no resumo do input', () => {
    const v = toolView('mcp__x__y', { a: 1 })
    expect(v).toMatchObject({ category: 'other', label: 'mcp__x__y', target: '{"a":1}' })
  })

  it('input fora do shape esperado não quebra', () => {
    expect(toolView('Read', null).target).toBe('')
    expect(toolView('Edit', 'texto').diff).toBeUndefined()
  })
})

describe('lineDiff', () => {
  it('trecho vazio vira só adições', () => {
    expect(lineDiff('', 'a\nb').map((l) => l.sign)).toEqual(['+', '+'])
  })

  it('entrada enorme cai em "tudo saiu, tudo entrou" sem LCS', () => {
    const big = Array.from({ length: 600 }, (_, i) => `l${i}`).join('\n')
    const d = lineDiff(big, big + '\nnova')
    expect(d.filter((l) => l.sign === '-')).toHaveLength(600)
    expect(d.filter((l) => l.sign === '+')).toHaveLength(601)
  })
})

describe('summarizeTools', () => {
  it('agrupa por categoria em português, na ordem de leitura', () => {
    expect(summarizeTools(['Read', 'Bash', 'Read', 'Grep', 'Edit', 'Read'])).toBe(
      'Leu 3 arquivos · fez 1 busca · editou 1 arquivo · rodou 1 comando',
    )
  })

  it('anexa a contagem de erros', () => {
    expect(summarizeTools(['Bash', 'Bash'], 1)).toBe('Rodou 2 comandos · 1 erro')
  })
})

describe('previewLines', () => {
  it('corta nas primeiras linhas e conta o resto', () => {
    expect(previewLines('1\n2\n3\n4\n', 2)).toEqual({ shown: '1\n2', hidden: 2 })
    expect(previewLines('1\n2', 5)).toEqual({ shown: '1\n2', hidden: 0 })
  })
})

describe('shortPath', () => {
  it('mantém caminhos curtos e encurta os longos', () => {
    expect(shortPath('a/b')).toBe('a/b')
    expect(shortPath('/x/y/z/w.ts')).toBe('…/z/w.ts')
  })
})
