import { describe, expect, it } from 'vitest'
import {
  activeMentionToken,
  applyCompletion,
  filterFiles,
  fuzzyScore,
  parseSend,
  rewriteFileMentions,
} from './mention-parser'
import type { SendTarget } from '@/features/quick-composer/target-search'

function target(over: Partial<SendTarget>): SendTarget {
  return {
    sessionId: 'pty-a',
    ccSessionId: 'cc-a',
    alias: 'api',
    label: 'api',
    projectName: 'Alpha',
    projectColor: null,
    status: 'idle',
    cwd: '/repos/alpha',
    purpose: null,
    ...over,
  }
}

const A = target({})
const B = target({
  sessionId: 'pty-b',
  ccSessionId: 'cc-b',
  alias: 'mauricio',
  label: 'mauricio',
  projectName: 'Beta',
  cwd: '/repos/beta',
})

describe('parseSend — destino e corpo', () => {
  it('@alias no início troca o destino e sai do corpo', () => {
    const res = parseSend('@mauricio rode os testes', [A, B], A)
    expect(res).toEqual({ kind: 'ok', target: B, body: 'rode os testes' })
  })

  it('sem @ vai pro destino padrão', () => {
    expect(parseSend('rode os testes', [A, B], A)).toEqual({
      kind: 'ok',
      target: A,
      body: 'rode os testes',
    })
  })

  it('@alias sem sessão viva com esse nome NÃO envia', () => {
    expect(parseSend('@fantasma faz isso', [A, B], A)).toEqual({
      kind: 'no-match',
      alias: 'fantasma',
    })
  })

  it('alias é case-insensitive', () => {
    const res = parseSend('@Mauricio oi', [A, B], A)
    expect(res.kind === 'ok' && res.target).toBe(B)
  })

  it('dois destinos com o mesmo alias pedem escolha em vez de adivinhar', () => {
    const B2 = { ...B, sessionId: 'pty-b2' }
    const res = parseSend('@mauricio oi', [A, B, B2], A)
    expect(res.kind).toBe('ambiguous')
  })

  it('@arquivo com / ou extensão é menção de arquivo do claude, não destino', () => {
    expect(parseSend('@src/x.ts explica', [A, B], A)).toMatchObject({
      kind: 'ok',
      target: A,
      body: '@src/x.ts explica',
    })
    expect(parseSend('@README.md resume', [A, B], A)).toMatchObject({ kind: 'ok', target: A })
  })

  it('@agent-… (subagente do Claude Code) não vira destino', () => {
    expect(parseSend('@agent-reviewer olha isso', [A, B], A)).toMatchObject({
      kind: 'ok',
      target: A,
    })
  })

  it('#arquivo escolhido no menu vira @arquivo relativo ao cwd do DESTINO', () => {
    const picked = new Set(['src/x.ts', '/repos/beta/lib/y.ts'])
    const res = parseSend('@mauricio rode os testes #src/x.ts', [A, B], A, picked)
    expect(res).toEqual({ kind: 'ok', target: B, body: 'rode os testes @src/x.ts' })
    const abs = parseSend('@mauricio olha #/repos/beta/lib/y.ts', [A, B], A, picked)
    expect(abs.kind === 'ok' && abs.body).toBe('olha @lib/y.ts')
  })

  it('texto colado com # que não veio do menu segue intacto', () => {
    const script = '#!/usr/bin/env bash\necho oi #v1.2 seção #3.1 #app.dark'
    expect(parseSend(script, [A, B], A)).toEqual({ kind: 'ok', target: A, body: script })
  })

  it('só o alias, sem corpo, não envia nada', () => {
    expect(parseSend('@mauricio   ', [A, B], A)).toEqual({ kind: 'empty' })
  })

  it('sem destino padrão e sem @ não há pra onde mandar', () => {
    expect(parseSend('oi', [A, B], null)).toEqual({ kind: 'no-target' })
  })
})

describe('rewriteFileMentions', () => {
  const picked = new Set(['/etc/hosts', 'fff.css', 'src/x.ts'])

  it('não mexe em #123 nem em # solto', () => {
    expect(rewriteFileMentions('fecha a #123 e # isso', '/r', picked)).toBe('fecha a #123 e # isso')
  })

  it('caminho absoluto fora do cwd fica absoluto', () => {
    expect(rewriteFileMentions('veja #/etc/hosts', '/r', picked)).toBe('veja @/etc/hosts')
  })

  it('# colado numa palavra não é menção', () => {
    expect(rewriteFileMentions('cor#fff.css', '/r', picked)).toBe('cor#fff.css')
  })

  it('caminho relativo digitado à mão vira menção; absoluto só se veio do menu', () => {
    expect(rewriteFileMentions('rode #src/x.ts', '/r', new Set())).toBe('rode @src/x.ts')
    expect(rewriteFileMentions('veja #/etc/hosts', '/r', new Set())).toBe('veja #/etc/hosts')
  })

  it('só reescreve o que foi escolhido no menu: shebang e #/json-pointer ficam', () => {
    expect(rewriteFileMentions('#!/usr/bin/env node', '/r', picked)).toBe('#!/usr/bin/env node')
    expect(rewriteFileMentions('veja #/definitions/x e #src/x.ts', '/r', picked)).toBe(
      'veja #/definitions/x e @src/x.ts',
    )
  })
})

describe('activeMentionToken', () => {
  it('@ só abre o menu de sessões no início do texto', () => {
    expect(activeMentionToken('@mau', 4)).toEqual({
      kind: 'session',
      query: 'mau',
      start: 0,
      end: 4,
    })
    expect(activeMentionToken('oi @mau', 7)).toBeNull()
  })

  it('# abre o menu de arquivos em qualquer lugar', () => {
    expect(activeMentionToken('rode #src/x', 11)).toEqual({
      kind: 'file',
      query: 'src/x',
      start: 5,
      end: 11,
    })
  })

  it('o token vai até o próximo espaço mesmo com o caret no meio', () => {
    expect(activeMentionToken('#src/xy resto', 3)).toMatchObject({ start: 0, end: 7 })
  })

  it('@ que não é slug de sessão (caminho, subagente) não abre o menu de sessões', () => {
    expect(activeMentionToken('@src/x.ts', 9)).toBeNull()
    expect(activeMentionToken('@README.md', 10)).toBeNull()
    expect(activeMentionToken('@agent-reviewer', 15)).toBeNull()
    expect(activeMentionToken('@', 1)).toMatchObject({ kind: 'session', query: '' })
  })

  it('fora de token não há menu', () => {
    expect(activeMentionToken('rode os testes', 4)).toBeNull()
  })
})

describe('applyCompletion', () => {
  it('troca o token inteiro e deixa um espaço depois', () => {
    const tok = activeMentionToken('@mau rode', 2)!
    expect(applyCompletion('@mau rode', tok, '@mauricio')).toEqual({
      value: '@mauricio rode',
      caret: 10,
    })
    const end = activeMentionToken('olha #sr', 8)!
    expect(applyCompletion('olha #sr', end, '#src/x.ts')).toEqual({
      value: 'olha #src/x.ts ',
      caret: 15,
    })
  })
})

describe('fuzzy', () => {
  it('subsequência casa, prefixo pontua mais', () => {
    expect(fuzzyScore('mau', 'mauricio')).not.toBeNull()
    expect(fuzzyScore('mrc', 'mauricio')).not.toBeNull()
    expect(fuzzyScore('xyz', 'mauricio')).toBeNull()
    expect(fuzzyScore('mau', 'mauricio')!).toBeGreaterThan(fuzzyScore('mrc', 'mauricio')!)
  })

  it('filterFiles prefere o nome do arquivo e corta no limite', () => {
    const files = ['docs/x-guide.md', 'src/x.ts', 'src/deep/other.ts']
    expect(filterFiles('x.ts', files, 5)[0]).toBe('src/x.ts')
    expect(filterFiles('', files, 2)).toEqual(['docs/x-guide.md', 'src/x.ts'])
  })
})
